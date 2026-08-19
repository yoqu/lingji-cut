// 发布执行编排（项目无关）：一键发布 → 登录失效弹窗确认 → 就地重登 → 自动续发 → 汇总历史。
// 从 PublishWorkbench 抽出，供项目发布 tab 与发布中心共用。

import { useEffect, useRef, useState } from 'react';
import { usePublishStore, type PublishResult } from '../../../store/publish';
import type { PublishAccount, PublishShared, PublishTarget } from '../../../lib/electron-api';
import type {
  PublishHistoryEntry,
  PublishHistoryResult,
  PublishHistoryTarget,
} from '../../../lib/project-persistence';

/** 渲染层 basename：避免引入 node:path。 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export interface ReloginMessage {
  text: string;
  isError: boolean;
}

export interface PublishRunner {
  isPublishing: boolean;
  results: Record<string, PublishResult>;
  cancelPublish: () => void;
  /** 执行发布并返回汇总的历史记录（含登录失效自动续发后的最终结果）。 */
  runPublish: (
    filePath: string,
    shared: PublishShared,
    targets: PublishTarget[],
    historyTargets: PublishHistoryTarget[],
  ) => Promise<PublishHistoryEntry>;
  /** 手动就地重登（成功后由用户手动重发）。 */
  relogin: (target: PublishHistoryTarget) => Promise<void>;
  reloginBusyId: string | null;
  reloginMsg: ReloginMessage | null;
  qrcodePng: string | null;
  /** 发布中检测到登录失效时待确认的账号（驱动 ConfirmDialog）。 */
  loginPrompt: PublishHistoryTarget | null;
  resolveLoginPrompt: (ok: boolean) => void;
}

export function usePublishRunner(): PublishRunner {
  const { job, results, startPublish, cancelPublish, addAccount } = usePublishStore();
  const settings = usePublishStore((s) => s.settings);

  const [qrcodePng, setQrcodePng] = useState<string | null>(null);
  const [reloginBusyId, setReloginBusyId] = useState<string | null>(null);
  const [reloginMsg, setReloginMsg] = useState<ReloginMessage | null>(null);
  const unsubQrcodeRef = useRef<(() => void) | null>(null);
  const [loginPrompt, setLoginPrompt] = useState<PublishHistoryTarget | null>(null);
  const loginPromptResolveRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      unsubQrcodeRef.current?.();
      unsubQrcodeRef.current = null;
    },
    [],
  );

  const askRelogin = (target: PublishHistoryTarget): Promise<boolean> =>
    new Promise((resolve) => {
      loginPromptResolveRef.current = resolve;
      setLoginPrompt(target);
    });

  // 关闭弹窗并回传用户决策（幂等：confirm / cancel / 蒙层关闭只兑现一次）
  const resolveLoginPrompt = (ok: boolean) => {
    const resolve = loginPromptResolveRef.current;
    loginPromptResolveRef.current = null;
    setLoginPrompt(null);
    resolve?.(ok);
  };

  // 重登核心：挂二维码事件 → 触发登录 → 返回是否成功。手动重登与发布中自动续发共用。
  const reloginAccount = async (target: PublishHistoryTarget): Promise<boolean> => {
    const platform = target.platform as PublishAccount['platform'];
    setReloginBusyId(target.accountId);
    setReloginMsg({
      text: settings.headlessLogin
        ? `正在为 ${target.accountName} 重新登录，二维码将显示在下方，请扫码…`
        : `正在为 ${target.accountName} 打开浏览器扫码登录…`,
      isError: false,
    });
    setQrcodePng(null);
    if (!unsubQrcodeRef.current) {
      unsubQrcodeRef.current = window.publishAPI.onQrcode((p) => setQrcodePng(p.png));
    }
    try {
      const res = await addAccount(platform, target.accountName);
      if (res.success) setQrcodePng(null);
      else setReloginMsg({ text: res.message || '登录失败', isError: true });
      return res.success;
    } catch (err) {
      setReloginMsg({ text: err instanceof Error ? err.message : '登录异常', isError: true });
      return false;
    } finally {
      setReloginBusyId(null);
      unsubQrcodeRef.current?.();
      unsubQrcodeRef.current = null;
    }
  };

  const relogin = async (target: PublishHistoryTarget) => {
    const ok = await reloginAccount(target);
    if (ok) setReloginMsg({ text: '重新登录成功，可点「重新发布」重试', isError: false });
  };

  // 执行发布并汇总一条历史记录（新发布与重新发布共用）
  const runPublish = async (
    filePath: string,
    shared: PublishShared,
    targets: PublishTarget[],
    historyTargets: PublishHistoryTarget[],
  ): Promise<PublishHistoryEntry> => {
    try {
      await startPublish(filePath, shared, targets, true);
    } catch {
      // 错误已在 store 内处理（failTask）；下方仍据最终 results 落历史
    }
    // 合并各账号最终结果（自动续发会逐账号覆盖）
    const merged: Record<string, PublishResult> = { ...usePublishStore.getState().results };

    // ── 登录态失效自动续发：弹窗确认 → 重登 → 立即重发该账号 ──
    const expired = historyTargets.filter((t) => merged[t.accountId]?.state === 'login-expired');
    for (const t of expired) {
      const confirmed = await askRelogin(t);
      if (!confirmed) continue; // 用户取消：保留失效态（落历史记为失败）
      const loggedIn = await reloginAccount(t);
      if (!loggedIn) continue; // 重登失败/取消扫码：保留
      setReloginMsg({ text: `${t.accountName} 登录成功，正在继续发布…`, isError: false });
      const single: PublishTarget = {
        accountId: t.accountId,
        ...(t.bilibiliTid != null ? { bilibili: { tid: t.bilibiliTid } } : {}),
      };
      try {
        await startPublish(filePath, shared, [single], true);
      } catch {
        /* 失败据 results 落历史 */
      }
      merged[t.accountId] = usePublishStore.getState().results[t.accountId] ?? merged[t.accountId];
      const okNow = merged[t.accountId]?.state === 'success';
      setReloginMsg({
        text: okNow ? `${t.accountName} 发布成功` : `${t.accountName} 续发未成功，可稍后重试`,
        isError: !okNow,
      });
    }

    const resultMap: Record<string, PublishHistoryResult> = {};
    let okCount = 0;
    for (const t of historyTargets) {
      const ok = merged[t.accountId]?.state === 'success';
      if (ok) okCount += 1;
      resultMap[t.accountId] = {
        state: ok ? 'success' : 'failed',
        message: ok ? undefined : merged[t.accountId]?.message,
      };
    }
    const overallState: PublishHistoryEntry['overallState'] =
      okCount === historyTargets.length ? 'success' : okCount === 0 ? 'failed' : 'partial';
    return {
      id: crypto.randomUUID(),
      publishedAt: Date.now(),
      fileName: baseName(filePath),
      filePath,
      shared: {
        title: shared.title,
        desc: shared.desc,
        tags: shared.tags,
        thumbnail: shared.thumbnail,
        covers: shared.covers,
        bilibiliTid: historyTargets.find((t) => t.bilibiliTid != null)?.bilibiliTid,
      },
      targets: historyTargets,
      results: resultMap,
      overallState,
    };
  };

  return {
    isPublishing: !!job,
    results,
    cancelPublish,
    runPublish,
    relogin,
    reloginBusyId,
    reloginMsg,
    qrcodePng,
    loginPrompt,
    resolveLoginPrompt,
  };
}
