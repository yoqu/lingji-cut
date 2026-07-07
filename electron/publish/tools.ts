/**
 * 发布能力的控制服务工具：账号查询/校验 + 发布任务（走 pipeline 任务模型）。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import type { ToolRegistrar } from '../control/registry';
import { getPublishStore } from './ipc';
import { getPlatform } from './platforms';
import { parseAccountId } from './account-id';
import { runPublishJob } from './runner';
import { getPipelineService } from '../pipeline';
import type { PublishJob } from './types';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(message: string, code?: string) {
  const payload: Record<string, unknown> = { error: message };
  if (code) payload.code = code;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function registerPublishTools(
  server: ToolRegistrar,
  getMainWindow: () => BrowserWindow | null,
): void {
  server.registerTool(
    'lingji_list_publish_accounts',
    {
      title: '列出发布账号',
      description: '返回各平台已登录的发布账号（id/platform/accountName/status）。登录需在应用发布页扫码完成。',
    },
    async () => {
      try {
        const list = getPublishStore()
          .list()
          .map(({ id, platform, accountName, status, lastCheckedAt }) => ({
            id,
            platform,
            accountName,
            status,
            lastCheckedAt,
          }));
        return jsonResult(list);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'lingji_check_publish_account',
    {
      title: '校验发布账号登录态',
      description: '按 accountId 校验平台 cookie/session 是否仍有效，并更新账号状态。',
      inputSchema: { accountId: z.string().describe('账号 id（platform_accountName）') },
    },
    async ({ accountId }) => {
      try {
        const store = getPublishStore();
        const acc = store.list().find((a) => a.id === accountId);
        if (!acc) return errorResult(`账号不存在: ${accountId}`, 'account_not_found');
        const { platform } = parseAccountId(accountId);
        const ok = await getPlatform(platform).checkCookie(acc.storageStatePath);
        store.setStatus(accountId, ok ? 'valid' : 'expired', Date.now());
        return jsonResult({ accountId, valid: ok });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'lingji_publish_video',
    {
      title: '发布视频到平台',
      description:
        '把视频上传到指定发布账号（抖音/视频号/小红书/快手/B站）。返回 taskId（fire-and-poll，用 lingji_get_task_status 查询）。账号需先在应用发布页登录。',
      inputSchema: {
        projectPath: z.string().describe('项目目录绝对路径（任务归属）'),
        filePath: z.string().describe('要发布的视频文件绝对路径'),
        title: z.string().describe('标题'),
        desc: z.string().optional().describe('简介/描述'),
        tags: z.array(z.string()).optional().describe('话题标签'),
        accountIds: z.array(z.string()).min(1).describe('目标账号 id 列表'),
        thumbnail: z.string().optional().describe('封面图片路径（单封面兜底）'),
        scheduleAt: z.number().optional().describe('定时发布时间戳（毫秒）'),
        bilibiliTid: z.number().optional().describe('B 站分区 id（发 B 站时使用）'),
        headless: z.boolean().optional().describe('无头模式，默认 true'),
      },
    },
    async ({ projectPath, filePath, title, desc, tags, accountIds, thumbnail, scheduleAt, bilibiliTid, headless }) => {
      try {
        const { taskId } = await getPipelineService().createTask('publish', projectPath, async (handle) => {
          const job: PublishJob = {
            id: randomUUID(),
            filePath,
            shared: { title, desc: desc ?? '', tags: tags ?? [], thumbnail, scheduleAt },
            targets: (accountIds as string[]).map((accountId) => ({
              accountId,
              ...(bilibiliTid && accountId.startsWith('bilibili') ? { bilibili: { tid: bilibiliTid } } : {}),
            })),
            results: {},
          };
          const total = accountIds.length;
          let done = 0;
          const results = await runPublishJob(
            job,
            getPublishStore(),
            (payload) => {
              if (payload.state !== 'running') done += 1;
              const base = ((done / total) * 100) | 0;
              handle.update({
                phase: `${payload.accountId}: ${payload.message ?? payload.state}`,
                percent: Math.min(99, base + ((payload.percent ?? 0) / total) | 0),
              });
              if (payload.message) handle.log(`[${payload.accountId}] ${payload.state} ${payload.message}`);
              // 同步转发给渲染端发布页（若在看）
              try {
                getMainWindow()?.webContents.send('publish:progress', payload);
              } catch {
                // 窗口可能已关闭
              }
            },
            () => handle.signal.aborted,
            headless ?? true,
          );
          const states = Object.values(results);
          if (states.length > 0 && states.every((r) => r.state !== 'success')) {
            throw new Error(`全部发布目标失败: ${states[0]?.message ?? states[0]?.state}`);
          }
          handle.update({ phase: '完成', percent: 100 });
          return { results };
        });
        return jsonResult({ taskId, kind: 'publish' });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return errorResult(e?.message ?? String(err), e?.code);
      }
    },
  );
}
