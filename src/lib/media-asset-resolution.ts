import type { AssetLibraryFile, AssetRecord } from '../types/assets';
import type {
  AudioAssetConstraints,
  ImageAssetConstraints,
  MediaAssetRequest,
  VideoAssetConstraints,
} from '../types/production';

export interface MediaAssetCandidate {
  asset: AssetRecord;
  score: number;
  reasons: string[];
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[\s,，、/|;；:_-]+/u).filter(Boolean));
}

function cjkBigrams(value: string): Set<string> {
  const clean = normalized(value).replace(/[^\p{L}\p{N}]/gu, '');
  const result = new Set<string>();
  for (let index = 0; index < clean.length - 1; index += 1) result.add(clean.slice(index, index + 2));
  return result;
}

function durationMatches(
  durationMs: number | null | undefined,
  range?: [number, number],
  canTrimOrLoop = false,
): boolean {
  if (!range) return true;
  if (typeof durationMs !== 'number' || durationMs < range[0]) return false;
  return canTrimOrLoop || durationMs <= range[1];
}

function matchesAudio(asset: AssetRecord, constraints: AudioAssetConstraints): boolean {
  const audio = asset.metadata.audio;
  if (!durationMatches(asset.metadata.durationMs, constraints.durationRangeMs, constraints.loopable)) return false;
  if (constraints.loopable && !audio?.loopable) return false;
  if (constraints.key && audio?.key && constraints.key !== audio.key) return false;
  if (constraints.bpmRange && audio?.bpm != null) {
    if (audio.bpm < constraints.bpmRange[0] || audio.bpm > constraints.bpmRange[1]) return false;
  }
  if (constraints.energy && audio?.energy && constraints.energy !== audio.energy) return false;
  if (
    constraints.transientType &&
    audio?.transientType &&
    constraints.transientType !== audio.transientType
  ) return false;
  return true;
}

function matchesVideo(asset: AssetRecord, constraints: VideoAssetConstraints): boolean {
  const video = asset.metadata.video;
  if (!durationMatches(asset.metadata.durationMs, constraints.durationRangeMs)) return false;
  if (constraints.loopable && !video?.loopable) return false;
  if (constraints.minWidth && (asset.metadata.width ?? 0) < constraints.minWidth) return false;
  if (constraints.minHeight && (asset.metadata.height ?? 0) < constraints.minHeight) return false;
  if (constraints.aspectRatio && video?.aspectRatio && constraints.aspectRatio !== video.aspectRatio) return false;
  return true;
}

function matchesImage(asset: AssetRecord, constraints: ImageAssetConstraints): boolean {
  if (constraints.minWidth && (asset.metadata.width ?? 0) < constraints.minWidth) return false;
  if (constraints.minHeight && (asset.metadata.height ?? 0) < constraints.minHeight) return false;
  if (constraints.hasAlpha && !asset.metadata.hasAlpha) return false;
  return true;
}

function hardConstraintsMatch(request: MediaAssetRequest, asset: AssetRecord): boolean {
  if (asset.kind !== request.kind || asset.usage.deprecated) return false;
  if (asset.metadata.quality?.status === 'rejected' || asset.metadata.quality?.status === 'pending') return false;
  if (asset.sourceType === 'ai-generated' && asset.metadata.quality?.status !== 'passed') return false;
  if (request.role && asset.role !== request.role && asset.role !== request.kind) return false;
  if (request.kind === 'audio') return matchesAudio(asset, request.constraints as AudioAssetConstraints);
  if (request.kind === 'video') return matchesVideo(asset, request.constraints as VideoAssetConstraints);
  return matchesImage(asset, request.constraints as ImageAssetConstraints);
}

function audioMetadataScore(
  request: MediaAssetRequest,
  asset: AssetRecord,
): { score: number; reasons: string[]; incomplete: boolean } {
  if (request.kind !== 'audio') return { score: 0, reasons: [], incomplete: false };
  const constraints = request.constraints as AudioAssetConstraints;
  const audio = asset.metadata.audio;
  const reasons: string[] = [];
  let score = 0;
  let incomplete = false;
  const exact = (wanted: unknown, actual: unknown, points: number, label: string) => {
    if (wanted == null) return;
    if (actual == null || actual === '') {
      incomplete = true;
      reasons.push(`${label}元数据缺失`);
      return;
    }
    if (wanted === actual) {
      score += points;
      reasons.push(`${label}一致`);
    }
  };
  exact(constraints.energy, audio?.energy, 8, '能量');
  exact(constraints.key, audio?.key, 6, 'Key');
  exact(constraints.transientType, audio?.transientType, 12, '瞬态类型');
  if (constraints.bpmRange) {
    if (audio?.bpm == null) {
      incomplete = true;
      reasons.push('BPM 元数据缺失');
    } else {
      score += 6;
      reasons.push('BPM 区间符合');
    }
  }
  if (constraints.mood?.length) {
    const assetText = normalized([
      asset.name,
      ...asset.semantic.tags,
      ...asset.semantic.topics,
      ...asset.semantic.style,
    ].join(' '));
    const moodHits = constraints.mood.filter((mood) => assetText.includes(normalized(mood))).length;
    if (moodHits > 0) {
      score += Math.min(16, moodHits * 8);
      reasons.push(`命中 ${moodHits} 个情绪标签`);
    }
  }
  return { score, reasons, incomplete };
}

function scoreCandidate(request: MediaAssetRequest, asset: AssetRecord): MediaAssetCandidate {
  const reasons: string[] = [];
  let score = 0;
  if (asset.metadata.reuseKey && asset.metadata.reuseKey === request.reuseKey) {
    score += 80;
    reasons.push('生成规格完全一致');
  }
  if (normalized(asset.name) === normalized(request.query)) {
    score += 55;
    reasons.push('名称一致');
  }
  const queryTokens = tokens(request.query);
  const assetText = [asset.name, ...asset.semantic.tags, ...asset.semantic.topics, ...asset.semantic.style].join(' ');
  const assetTokens = tokens(assetText);
  const tokenHits = [...queryTokens].filter((token) => assetTokens.has(token)).length;
  if (tokenHits > 0) {
    score += Math.min(28, tokenHits * 14);
    reasons.push(`命中 ${tokenHits} 个标签`);
  }
  const queryGrams = cjkBigrams(request.query);
  const assetGrams = cjkBigrams(assetText);
  const overlap = [...queryGrams].filter((gram) => assetGrams.has(gram)).length;
  if (queryGrams.size > 0 && overlap > 0) {
    score += Math.round((overlap / queryGrams.size) * 24);
    reasons.push('语义描述接近');
  }
  if (asset.usage.favorite) {
    score += 8;
    reasons.push('已收藏');
  }
  if ((asset.usage.rating ?? 0) >= 4) {
    score += 6;
    reasons.push('高评分');
  }
  if ((asset.usage.usageCount ?? 0) > 0) score += Math.min(6, asset.usage.usageCount ?? 0);
  const metadata = audioMetadataScore(request, asset);
  score += metadata.score;
  reasons.push(...metadata.reasons);
  const normalizedScore = Math.min(100, score);
  return {
    asset,
    score: metadata.incomplete ? Math.min(74, normalizedScore) : normalizedScore,
    reasons,
  };
}

export function findReusableMediaAssets(
  request: MediaAssetRequest,
  library: AssetLibraryFile,
): MediaAssetCandidate[] {
  return library.assets
    .filter((asset) => hardConstraintsMatch(request, asset))
    .map((asset) => scoreCandidate(request, asset))
    .filter((candidate) => candidate.score >= 55)
    .sort((left, right) => right.score - left.score);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildMediaReuseKey(
  request: Omit<MediaAssetRequest, 'id' | 'reuseKey'>,
): string {
  const payload = JSON.stringify(stable({
    kind: request.kind,
    role: request.role,
    query: normalized(request.query),
    constraints: request.constraints,
  }));
  return `${request.kind}:${request.role}:${hashText(payload)}`;
}
