import { useCallback, useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { Badge, Button, Field, Input, Switch } from '../../ui';
import { DEFAULT_KACUT_BASE_URL, type KacutSettings } from '../../types/ai';
import type { KacutLibraryDigest } from '../../types/footage';
import { normalizeKacutMcpEndpoint } from '../../lib/kacut-endpoint';
import styles from './KacutConnectSection.module.css';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'connected'; digest: KacutLibraryDigest | null }
  | { status: 'failed' };

/**
 * 灵机素材（KaCut）联动区：footage 轨总开关 + 本机 MCP 服务地址 + 连接测试。
 * 跟随本 tab 其他全局调度配置（并发数 / 出卡模式）的即改即存模式，
 * baseUrl 失焦时才落盘，连接测试针对输入框中的当前地址。
 */
export function KacutConnectSection({
  kacut,
  disabled,
  onSave,
}: {
  kacut: KacutSettings;
  /** 设置尚未加载完成时禁用交互。 */
  disabled?: boolean;
  onSave: (next: KacutSettings) => Promise<void>;
}) {
  const [baseUrlDraft, setBaseUrlDraft] = useState(kacut.baseUrl);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  /** 外部配置刷新（如保存后 reload）时同步草稿；输入过程中 prop 不变，不会打断输入 */
  useEffect(() => {
    setBaseUrlDraft(kacut.baseUrl);
  }, [kacut.baseUrl]);

  const commitBaseUrl = useCallback(async () => {
    const next = normalizeKacutMcpEndpoint(baseUrlDraft || DEFAULT_KACUT_BASE_URL);
    if (!next) {
      setTestState({ status: 'failed' });
      return;
    }
    if (next === kacut.baseUrl) return;
    await onSave({ ...kacut, baseUrl: next });
    setBaseUrlDraft(next);
  }, [baseUrlDraft, kacut, onSave]);

  const runTest = useCallback(async () => {
    const baseUrl = normalizeKacutMcpEndpoint(baseUrlDraft || DEFAULT_KACUT_BASE_URL);
    setTestState({ status: 'testing' });
    if (!baseUrl) {
      setTestState({ status: 'failed' });
      return;
    }
    try {
      const ok = await window.electronAPI.kacutHealth(baseUrl);
      if (!ok) {
        setTestState({ status: 'failed' });
        return;
      }
      await onSave({ ...kacut, baseUrl, enabled: true });
      setBaseUrlDraft(baseUrl);
      // 摘要失败不影响"已连接"结论，只是没有统计行
      const digest = await window.electronAPI.kacutLibraryDigest(baseUrl).catch(() => null);
      setTestState({ status: 'connected', digest });
    } catch {
      setTestState({ status: 'failed' });
    }
  }, [baseUrlDraft, kacut, onSave]);

  return (
    <Field
      label="灵机素材（KaCut）联动"
      hint="启用后，导演会检索并预览本机真实素材，再按每个镜头批准的独立素材、Agent 合成或显式退路执行；未启用时不会检索新的本机素材。"
    >
      <div className={styles.block}>
        <Switch
          checked={kacut.enabled}
          disabled={disabled}
          label="启用素材联动"
          onChange={(enabled) => {
            if (enabled) {
              void runTest();
              return;
            }
            setTestState({ status: 'idle' });
            void onSave({ ...kacut, enabled: false }).catch(() => undefined);
          }}
        />
        <div className={styles.urlRow}>
          <Input
            value={baseUrlDraft}
            disabled={disabled}
            placeholder={DEFAULT_KACUT_BASE_URL}
            aria-label="灵机素材服务地址"
            onChange={(event) => {
              setBaseUrlDraft(event.target.value);
              setTestState({ status: 'idle' });
            }}
            onBlur={(event) => {
              // Clicking "测试连接" must perform one atomic baseUrl + enabled save.
              // Do not start a competing stale onBlur save immediately before it.
              const nextTarget = event.relatedTarget as HTMLElement | null;
              if (nextTarget?.dataset.kacutTestButton === 'true') return;
              void commitBaseUrl().catch(() => undefined);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            loading={testState.status === 'testing'}
            loadingText="测试中"
            leftIcon={<PlugZap size={14} />}
            data-kacut-test-button="true"
            onClick={() => void runTest()}
          >
            测试连接
          </Button>
        </div>
        {testState.status === 'connected' ? (
          <div className={styles.statusRow} data-testid="kacut-status">
            <Badge variant="success" size="xs">已连接并启用</Badge>
            <span>{digestLine(testState.digest)}</span>
          </div>
        ) : null}
        {testState.status === 'failed' ? (
          <div className={styles.statusRow} data-testid="kacut-status">
            <Badge variant="warning" size="xs">未连接</Badge>
            <span>连接失败，请确认灵机素材 App 已开启 MCP 服务，且地址中的访问 Token 有效。</span>
          </div>
        ) : null}
      </div>
    </Field>
  );
}

const KIND_LABEL: Record<string, string> = {
  video: '视频',
  image: '图片',
  gif: 'GIF',
  audio: '音频',
};
const KIND_ORDER = ['video', 'image', 'gif', 'audio'];

/** 素材库摘要一行展示：`3 个库 · 1,234 条素材 · 视频 800 · 图片 400` */
function digestLine(digest: KacutLibraryDigest | null): string {
  if (!digest) return '素材库摘要获取失败，不影响素材检索。';
  const kinds = [...KIND_ORDER, ...Object.keys(digest.kindCounts).filter((k) => !KIND_ORDER.includes(k))]
    .filter((kind, index, all) => all.indexOf(kind) === index && (digest.kindCounts[kind] ?? 0) > 0)
    .map((kind) => `${KIND_LABEL[kind] ?? kind} ${(digest.kindCounts[kind] ?? 0).toLocaleString()}`);
  return [
    `${digest.libraryCount} 个库`,
    `${digest.itemCount.toLocaleString()} 条素材`,
    ...kinds,
  ].join(' · ');
}
