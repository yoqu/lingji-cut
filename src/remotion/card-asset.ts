import type { CardAssetBinding } from '../types/assets';

export interface AgentMediaAsset {
  slot: string;
  assetId: string;
  kind: 'image' | 'video';
  /** 已按当前预览 / 导出环境解析的可加载 URL。 */
  src: string;
  trimStartMs: number;
  durationMs?: number;
  metadata?: CardAssetBinding['metadata'];
  usage: 'required' | 'optional';
  required: boolean;
  lockedByUser: boolean;
}

const VIDEO_FILE_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi)(?:[?#].*)?$/i;

export function inferCardMediaKind(binding: CardAssetBinding): AgentMediaAsset['kind'] {
  if (binding.kind) return binding.kind;
  if (binding.metadata?.mimeHint?.toLowerCase().startsWith('video/')) return 'video';
  if (binding.metadata?.video) return 'video';
  return VIDEO_FILE_PATTERN.test(binding.filePath) ? 'video' : 'image';
}

function finiteNonNegative(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 把持久化绑定转换为生成组件可消费的纯运行时契约。只暴露解析后的 src，
 * 不把项目绝对路径写入 Agent 生成源码，也不携带旧版 placement 布局约束。
 */
export function resolveAgentMediaAssets(
  bindings: CardAssetBinding[] | undefined,
  resolveSrc: (filePath: string) => string,
): AgentMediaAsset[] {
  return (bindings ?? [])
    .filter((binding) => Boolean(binding.filePath))
    .map((binding) => {
      const usage = binding.usage ?? (binding.required === true ? 'required' : 'optional');
      return {
        slot: binding.slot,
        assetId: binding.assetId,
        kind: inferCardMediaKind(binding),
        src: resolveSrc(binding.filePath),
        trimStartMs: finiteNonNegative(binding.trimStartMs) ?? 0,
        durationMs: finitePositive(binding.durationMs) ?? finitePositive(binding.metadata?.durationMs),
        metadata: binding.metadata,
        usage,
        required: usage === 'required',
        lockedByUser: binding.lockedByUser === true,
      };
    });
}

/**
 * 卡片图片资源解析器。注入到 Motion Card 运行时（CardHost）的全局 `cardAsset`，
 * 让同一份卡片 TSX 在预览与导出两种环境下都能正确加载项目内图片：
 * - 导出（renderMedia，isRendering=true）：相对路径 → staticFile（已 materialize 到 bundle public）。
 * - 预览（@remotion/player）：相对路径 → file://<projectDir>/<rel>（webSecurity 关闭可读本地文件）。
 *
 * 卡片里统一写 `cardAsset('assets/xxx.png')`（项目相对路径），不写绝对路径、不内联巨型 base64。
 */
export function makeCardAssetResolver(opts: {
  isRendering: boolean;
  projectDir?: string | null;
  staticFile: (rel: string) => string;
  toFileSrc: (abs: string) => string;
}): (rel: string) => string {
  return (rel: string): string => {
    if (!rel) return rel;
    if (/^(?:https?:|file:|data:)/i.test(rel)) return rel;
    const normalized = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!opts.isRendering && opts.projectDir) {
      const root = opts.projectDir.replace(/[\\/]+$/, '');
      return opts.toFileSrc(`${root}/${normalized}`);
    }
    return opts.staticFile(normalized);
  };
}
