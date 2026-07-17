import type {
  AssetGenerationRequest,
  AssetLibraryFile,
  AssetRecord,
  AssetResolutionResult,
  CardAssetBinding,
  ProjectAssetManifest,
  StoryboardAssetRequest,
} from '../types/assets';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function tokenSet(value: string): Set<string> {
  const normalized = value.trim().toLowerCase();
  return new Set(
    normalized
      .split(/[\s,，、/|;；:_-]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function cjkBigrams(value: string): Set<string> {
  const normalized = normalizeText(value).replace(/[^\p{L}\p{N}]/gu, '');
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function scoreAsset(request: StoryboardAssetRequest, asset: AssetRecord, projectBoost: boolean): number {
  if (asset.kind !== 'image') return 0;
  if (request.role === 'object' && !['object', 'symbol', 'overlay'].includes(asset.role)) return 0;
  if (request.role !== 'object' && asset.role !== request.role) return 0;

  const query = normalizeText(request.query);
  const name = normalizeText(asset.name);
  let score = projectBoost ? 12 : 0;
  if (name === query) score += 100;
  if (name.includes(query) || query.includes(name)) score += 50;

  const queryTokens = tokenSet(request.query);
  const assetTokens = tokenSet([
    asset.name,
    asset.role,
    ...asset.semantic.tags,
    ...asset.semantic.topics,
    ...asset.semantic.style,
    ...asset.semantic.usableAs,
  ].join(' '));
  for (const token of queryTokens) {
    if (assetTokens.has(token)) score += 14;
  }
  const queryGrams = cjkBigrams(request.query);
  const assetGrams = cjkBigrams([asset.name, ...asset.semantic.tags, ...asset.semantic.topics].join(''));
  if (queryGrams.size > 0) {
    const overlap = [...queryGrams].filter((gram) => assetGrams.has(gram)).length;
    score += Math.round((overlap / queryGrams.size) * 32);
  }
  if (asset.treatment.profile === request.visualTreatment) score += 8;
  return score;
}

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

function placementSide(hint: string | undefined, index: number): 'left' | 'right' | 'center' {
  if (/右|right/i.test(hint ?? '')) return 'right';
  if (/中|center/i.test(hint ?? '')) return 'center';
  if (/左|left/i.test(hint ?? '')) return 'left';
  return index % 2 === 0 ? 'left' : 'right';
}

function resolvePlacement(request: StoryboardAssetRequest, index: number): CardAssetBinding['placement'] {
  const base = { referenceWidth: REFERENCE_WIDTH, referenceHeight: REFERENCE_HEIGHT };
  if (request.role === 'background' || request.role === 'texture') {
    return {
      ...base,
      x: 0,
      y: 0,
      width: REFERENCE_WIDTH,
      height: REFERENCE_HEIGHT,
      opacity: request.role === 'background' ? 0.58 : 0.24,
      depth: 'background',
    };
  }
  const side = placementSide(request.placementHint, index);
  const bottom = /下|bottom/i.test(request.placementHint ?? '');
  if (request.importance === 'primary') {
    const x = side === 'right' ? 1260 : side === 'center' ? 700 : 120;
    return { ...base, x, y: bottom ? 320 : 210, width: 540, rotation: side === 'left' ? -2 : 2, opacity: 0.96, depth: 'foreground' };
  }
  if (request.importance === 'secondary') {
    const x = side === 'right' ? 1430 : side === 'center' ? 790 : 150;
    return { ...base, x, y: bottom ? 430 : 190 + index * 36, width: 340, rotation: side === 'left' ? -1 : 1, opacity: 0.84, depth: 'midground' };
  }
  return { ...base, x: 160 + (index % 3) * 580, y: 130, width: 420, opacity: 0.22, depth: 'background' };
}

function makeGenerationPrompt(request: StoryboardAssetRequest): string {
  const needsCutout = ['object', 'symbol', 'overlay'].includes(request.role);
  const isDiagramProp = request.visualTreatment === 'diagram-prop';
  const style = isDiagramProp
    ? needsCutout
      ? '风格：明显非写实的卡通编辑插画、扁平图解造型、边缘清晰、均匀纯绿幕背景、主体完整、无文字水印；不可被误认为真实照片或新闻现场'
      : '风格：明显非写实的卡通编辑插画、扁平图解造型、构图完整、画面铺满、无文字水印，不要绿幕背景；不可被误认为真实照片或新闻现场'
    : needsCutout
      ? '风格：低饱和写实摄影、边缘清晰、均匀纯绿幕背景、主体完整、无文字水印'
      : '风格：低饱和写实摄影、构图完整、细节克制、画面铺满、无文字水印，不要绿幕背景';
  const base = [
    `生成${needsCutout ? '一个可抠图的' : '一张完整画面的'}${request.query}`,
    `用途：${request.role}`,
    `视觉处理：${request.visualTreatment}`,
    style,
  ];
  if (request.placementHint) base.push(`放置意图：${request.placementHint}`);
  if (request.negativePrompt) base.push(`避免：${request.negativePrompt}`);
  return base.join('\n');
}

function acceptedGeneratedAssetId(
  request: StoryboardAssetRequest,
  projectManifest: ProjectAssetManifest | null | undefined,
  sourceCardId?: string,
): string | null {
  const accepted = projectManifest?.generationRequests.find((item) =>
    (item.status === 'ready' || item.status === 'accepted') &&
    item.resultAssetId &&
    item.slot === request.slot &&
    item.query === request.query &&
    (sourceCardId ? item.sourceCardId === sourceCardId : true),
  );
  return accepted?.resultAssetId ?? null;
}

function buildBinding(
  request: StoryboardAssetRequest,
  asset: AssetRecord,
  index: number,
): CardAssetBinding {
  const isBackdrop = request.role === 'background' || request.role === 'texture';
  return {
    slot: request.slot,
    assetId: asset.id,
    filePath: asset.files.processed || asset.files.thumbnail || asset.files.original,
    treatment: asset.treatment,
    metadata: {
      width: asset.metadata.width,
      height: asset.metadata.height,
      hasAlpha: asset.metadata.hasAlpha,
      processedAt: asset.metadata.processedAt,
      processedColorKey: asset.metadata.processedColorKey,
    },
    placement: resolvePlacement(request, index),
    motion: {
      enter: isBackdrop || request.importance === 'ambient' ? 'fade-in' : 'fade-up-soft',
      emphasis: !isBackdrop && request.importance === 'primary' ? 'subtle-parallax' : 'none',
      exit: request.importance === 'ambient' || request.role === 'texture' ? 'fade-out' : 'hold',
      revealBeat: request.revealBeat,
    },
    request,
  };
}

export function buildAssetGenerationRequest(
  request: StoryboardAssetRequest,
  sourceCardId?: string,
): AssetGenerationRequest {
  const timestamp = nowIso();
  return {
    id: `asset_gen_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
    slot: request.slot,
    query: request.query,
    role: request.role,
    importance: request.importance,
    reusePolicy: request.reusePolicy,
    visualTreatment: request.visualTreatment,
    revealBeat: request.revealBeat,
    placementHint: request.placementHint,
    negativePrompt: request.negativePrompt,
    prompt: makeGenerationPrompt(request),
    status: 'pending',
    sourceCardId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function resolveStoryboardAssets(params: {
  requests: StoryboardAssetRequest[];
  library: AssetLibraryFile;
  projectManifest?: ProjectAssetManifest | null;
  sourceCardId?: string;
}): AssetResolutionResult {
  const { requests, library, projectManifest, sourceCardId } = params;
  const projectIds = new Set(projectManifest?.assetRefs.map((ref) => ref.assetId) ?? []);
  const bindings: CardAssetBinding[] = [];
  const generationRequests: AssetGenerationRequest[] = [];
  const unresolved: StoryboardAssetRequest[] = [];

  requests.forEach((request, index) => {
    const acceptedAssetId = acceptedGeneratedAssetId(request, projectManifest, sourceCardId);
    const acceptedAsset = acceptedAssetId
      ? library.assets.find((asset) => asset.id === acceptedAssetId)
      : null;
    if (acceptedAsset) {
      bindings.push(buildBinding(request, acceptedAsset, index));
      return;
    }

    if (request.reusePolicy === 'always-generate') {
      generationRequests.push(buildAssetGenerationRequest(request, sourceCardId));
      return;
    }

    const candidates = library.assets
      .map((asset) => ({
        asset,
        score: scoreAsset(request, asset, asset.sourceType === 'project-local' || projectIds.has(asset.id)),
      }))
      .filter((item) => item.score >= 24)
      .sort((a, b) => b.score - a.score);
    const match = candidates[0]?.asset;

    if (match) {
      bindings.push(buildBinding(request, match, index));
      return;
    }

    if (request.reusePolicy === 'manual-only') {
      unresolved.push(request);
      return;
    }
    generationRequests.push(buildAssetGenerationRequest(request, sourceCardId));
  });

  return { bindings, generationRequests, unresolved };
}

export function inspectResolvedCardAssets(result: AssetResolutionResult): Array<{
  severity: 'error' | 'warning';
  code: string;
  message: string;
}> {
  const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }> = [];
  for (const request of [...result.unresolved, ...result.generationRequests]) {
    issues.push({
      severity: request.importance === 'primary' ? 'error' : 'warning',
      code: request.importance === 'primary' ? 'primary-asset-missing' : 'asset-missing',
      message: `${request.importance === 'primary' ? '主视觉' : '辅助'}资产“${request.query}”未解析，卡片将降级显示。`,
    });
  }
  for (const binding of result.bindings) {
    const minSide = Math.min(binding.metadata?.width ?? Infinity, binding.metadata?.height ?? Infinity);
    if (minSide < 320) {
      issues.push({
        severity: minSide < 160 ? 'error' : 'warning',
        code: 'asset-resolution-low',
        message: `资产“${binding.request?.query ?? binding.slot}”分辨率偏低（${binding.metadata?.width ?? '?'}×${binding.metadata?.height ?? '?'}）。`,
      });
    }
    if (
      binding.request
      && ['object', 'symbol', 'overlay'].includes(binding.request.role)
      && binding.metadata?.hasAlpha === false
    ) {
      issues.push({
        severity: 'warning',
        code: 'asset-no-alpha',
        message: `物件“${binding.request.query}”没有透明通道，可能出现底色边框。`,
      });
    }
  }
  const profiles = new Set(result.bindings.map((binding) => binding.treatment.profile));
  if (profiles.size > 2) {
    issues.push({
      severity: 'warning',
      code: 'asset-treatment-conflict',
      message: '同一卡片混用了三种以上资产处理风格，画面可能不统一。',
    });
  }
  return issues;
}
