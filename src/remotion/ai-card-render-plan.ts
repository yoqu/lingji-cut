import type { AICardMediaType, AICardOverlayData } from '../types/ai';
import { isMediaContent } from '../types/ai';
import { hasRenderableJsx } from './compile-card';

/**
 * AI 卡片在 Remotion 里的渲染分支决策（纯函数，便于测试）：
 * - media：image / video 媒体卡，直接渲染 assetPath 指向的图片 / 视频
 * - card-host：motion-card 且有可执行的编译产物，交给 CardHost 求值
 * - placeholder：媒体未生成、motion-card 缺编译产物、或未知渲染模式 → 降级占位
 */
export type AICardRenderPlan =
  | { kind: 'media'; mediaType: AICardMediaType; assetPath: string }
  | { kind: 'card-host' }
  | { kind: 'placeholder' };

export function resolveAICardRenderPlan(
  card: AICardOverlayData,
  compiledJs?: string,
): AICardRenderPlan {
  // 媒体卡（image / video）：内容是 MediaCardContent，渲染真实素材而非走 CardHost。
  if (isMediaContent(card.content)) {
    const assetPath = card.content.assetPath?.trim();
    if (assetPath) {
      return { kind: 'media', mediaType: card.content.mediaType, assetPath };
    }
    // 素材尚未生成（assetPath 为空）→ 占位，避免空白 / 破图。
    return { kind: 'placeholder' };
  }

  // Motion 卡：预览/导出真正执行的是 compiledJs。打包态或磁盘态有时只保留
  // tsxPath，inline tsx 未及时 hydrate；这种情况下只要编译产物已到位就应交给 CardHost。
  if (card.renderMode === 'motion-card') {
    const tsx = card.motionCard?.tsx;
    if (!compiledJs) {
      return { kind: 'placeholder' };
    }
    if (tsx?.trim() && !hasRenderableJsx(tsx)) {
      return { kind: 'placeholder' };
    }
    return { kind: 'card-host' };
  }

  // 非媒体且非 motion-card 的未知渲染模式 → 占位提示重新生成。
  return { kind: 'placeholder' };
}
