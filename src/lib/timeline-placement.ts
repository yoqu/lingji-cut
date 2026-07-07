import type { OverlayItem } from '../types';

// ── Type Definitions ──

export interface PlacementResult {
  startMs: number;
  fits: boolean;
}

export interface FindNearestArgs {
  targetStartMs: number;
  durationMs: number;
  trackId: string;
  excludeOverlayId?: string;
  overlays: OverlayItem[];
}

export interface ClampDurationArgs {
  overlayId: string;
  startMs: number;
  requestedDurationMs: number;
  trackId: string;
  overlays: OverlayItem[];
  maxDurationMs?: number;
}

// ── Helpers ──

/**
 * 判断 overlay 是否参与碰撞检测（通用版：仅排除默认背景）
 */
export function isOverlayTrackManaged(overlay: OverlayItem): boolean {
  return overlay.overlayRole !== 'default-background';
}

// ── 通用碰撞放置检查 API ──

export interface CanPlaceAtArgs {
  trackId: string;
  startMs: number;
  durationMs: number;
  excludeOverlayId?: string;
  overlays: OverlayItem[];
}

export interface CanPlaceAtResult {
  ok: boolean;
  reason?: 'overlap';
}

/**
 * 判断指定轨道的区间 [startMs, startMs+durationMs) 是否可放置，
 * 不做任何自动 snap/偏移；遇到任何受管 overlay 重叠即返回 ok=false。
 */
export function canPlaceAt(args: CanPlaceAtArgs): CanPlaceAtResult {
  const { trackId, startMs, durationMs, excludeOverlayId, overlays } = args;
  const candidate = { startMs, durationMs };
  for (const other of overlays) {
    if (other.trackId !== trackId) continue;
    if (other.id === excludeOverlayId) continue;
    if (!isOverlayTrackManaged(other)) continue;
    if (overlaysOverlap(candidate, other)) {
      return { ok: false, reason: 'overlap' };
    }
  }
  return { ok: true };
}

/**
 * 半开区间 [startMs, startMs + durationMs) 重叠判断
 */
export function overlaysOverlap(
  left: { startMs: number; durationMs: number },
  right: { startMs: number; durationMs: number },
): boolean {
  return left.startMs < right.startMs + right.durationMs
    && right.startMs < left.startMs + left.durationMs;
}

// ── 获取同轨道的受管 overlay 并排序 ──

function getManagedOverlaysOnTrack(
  trackId: string,
  overlays: OverlayItem[],
  excludeOverlayId?: string,
): OverlayItem[] {
  return overlays
    .filter((o) =>
      o.trackId === trackId
      && isOverlayTrackManaged(o)
      && o.id !== excludeOverlayId,
    )
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * 在指定轨道上寻找离 targetStartMs 最近的可用放置位置
 */
export function findNearestAvailablePlacement(args: FindNearestArgs): PlacementResult {
  const { targetStartMs, durationMs, trackId, excludeOverlayId, overlays } = args;
  const managed = getManagedOverlaysOnTrack(trackId, overlays, excludeOverlayId);

  // 空轨道，直接放置
  if (managed.length === 0) {
    return { startMs: targetStartMs, fits: true };
  }

  // 检查目标位置是否与任何现有 overlay 重叠
  const candidate = { startMs: targetStartMs, durationMs };
  const hasConflict = managed.some((o) => overlaysOverlap(candidate, o));

  if (!hasConflict) {
    return { startMs: targetStartMs, fits: true };
  }

  // 目标位置有冲突，扫描所有间隙寻找最近的可用位置
  // 间隙包括：第一个 overlay 之前、overlay 之间、最后一个 overlay 之后
  interface Gap { start: number; end: number }
  const gaps: Gap[] = [];

  // 第一个 overlay 之前的间隙（从 0 开始）
  if (managed[0].startMs > 0) {
    gaps.push({ start: 0, end: managed[0].startMs });
  }

  // overlay 之间的间隙
  for (let i = 0; i < managed.length - 1; i++) {
    const gapStart = managed[i].startMs + managed[i].durationMs;
    const gapEnd = managed[i + 1].startMs;
    if (gapEnd > gapStart) {
      gaps.push({ start: gapStart, end: gapEnd });
    }
  }

  // 最后一个 overlay 之后的间隙（无限大）
  const lastEnd = managed[managed.length - 1].startMs + managed[managed.length - 1].durationMs;
  gaps.push({ start: lastEnd, end: Number.POSITIVE_INFINITY });

  // 在每个间隙中找到可以放下 durationMs 的最近起始位置
  let bestStart: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const gap of gaps) {
    const gapSize = gap.end - gap.start;
    if (gapSize < durationMs) continue;

    // 在此间隙中，理想放置位置是 targetStartMs（若在间隙内）
    // 否则取间隙中离 targetStartMs 最近的合法起始位置
    let candidateStart: number;
    if (targetStartMs >= gap.start && targetStartMs + durationMs <= gap.end) {
      candidateStart = targetStartMs;
    } else if (targetStartMs < gap.start) {
      candidateStart = gap.start;
    } else {
      // targetStartMs 在间隙右侧或间隙内但放不下
      // 尝试间隙末尾减去 durationMs
      candidateStart = Math.max(gap.start, gap.end - durationMs);
    }

    // 确保不超出间隙
    if (candidateStart + durationMs > gap.end && gap.end !== Number.POSITIVE_INFINITY) {
      continue;
    }

    const distance = Math.abs(candidateStart - targetStartMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStart = candidateStart;
    }
  }

  if (bestStart !== null) {
    return { startMs: bestStart, fits: true };
  }

  return { startMs: targetStartMs, fits: false };
}

/**
 * 根据相邻 overlay 和最大时长限制，钳制 overlay 时长
 */
export function clampOverlayDurationByNeighbors(args: ClampDurationArgs): number {
  const { overlayId, startMs, requestedDurationMs, trackId, overlays, maxDurationMs } = args;
  const managed = getManagedOverlaysOnTrack(trackId, overlays, overlayId);

  // 找到 startMs 之后最近的 overlay
  let maxGap = requestedDurationMs;
  for (const o of managed) {
    if (o.startMs > startMs) {
      const gap = o.startMs - startMs;
      maxGap = Math.min(maxGap, gap);
      break; // managed 已按 startMs 排序，取第一个即可
    }
  }

  let result = Math.min(requestedDurationMs, maxGap);
  if (maxDurationMs !== undefined) {
    result = Math.min(result, maxDurationMs);
  }

  return result;
}
