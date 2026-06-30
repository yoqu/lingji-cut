import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadProjectFile } from '../project-file';
import { HeadlessProjectContext } from './context';
import { updateCardInResult, removeCardInResult } from '../../src/lib/ai-persistence';
import { deleteCardAssets } from '../ai-card-assets';
import { GenerationError } from './generation-error';
import { parseSrt } from '../../src/lib/srt-parser';
import {
  buildPlainTranscriptRange,
  buildSegmentCuesBlock,
  buildSrtTextRange,
} from '../../src/lib/ai-analysis';
import { getStyleFacetBlock, getStylePresetById, resolveStylePresetId } from '../../src/lib/card-style';
import { loadEffectivePromptTemplate } from '../prompts-io';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from './headless-settings';
import { computeCardCues } from '../../src/remotion/timeline-to-sequences';
import { validateMotionCardTsx } from '../remotion/smoke-render';
import type { AICard, AISegment, AISegmentVisualType } from '../../src/types/ai';

const UPDATABLE: ReadonlyArray<keyof AICard> = [
  'title', 'enabled', 'displayMode', 'startMs', 'endMs', 'displayDurationMs', 'template', 'stylePresetId', 'cardPrompt',
];
const CARD_PROMPT_KINDS = ['cards.segment', 'cards.animation', 'card.image', 'card.video'] as const;

export interface CardSummary {
  id: string; segmentId: string; type: string; title: string;
  enabled: boolean; startMs: number; endMs: number; renderMode?: string;
}

async function readCards(projectPath: string) {
  const data = await loadProjectFile(projectPath);
  const analysisResult = data.aiAnalysis?.analysisResult ?? null;
  return { data, analysisResult, cards: analysisResult?.cards ?? [] };
}

export async function listCards(projectPath: string): Promise<CardSummary[]> {
  const { cards } = await readCards(projectPath);
  return cards.map((c) => ({
    id: c.id, segmentId: c.segmentId, type: c.type, title: c.title,
    enabled: c.enabled, startMs: c.startMs, endMs: c.endMs, renderMode: c.renderMode,
  }));
}

export async function getCard(projectPath: string, cardId: string): Promise<AICard> {
  const { cards } = await readCards(projectPath);
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new GenerationError('card_not_found', `卡片不存在: ${cardId}`);
  return card;
}

export async function updateCard(
  projectPath: string,
  cardId: string,
  updates: Partial<AICard>,
): Promise<AICard> {
  const { data, analysisResult, cards } = await readCards(projectPath);
  if (!cards.some((c) => c.id === cardId)) {
    throw new GenerationError('card_not_found', `卡片不存在: ${cardId}`);
  }
  const clean: Partial<AICard> = {};
  for (const k of UPDATABLE) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) {
      (clean as Record<string, unknown>)[k] = (updates as Record<string, unknown>)[k];
    }
  }
  const next = updateCardInResult(analysisResult, cardId, clean);
  await new HeadlessProjectContext(projectPath).saveSection('aiAnalysis', {
    analysisResult: next,
    coverCandidates: data.aiAnalysis?.coverCandidates ?? [],
  });
  return next!.cards.find((c) => c.id === cardId)!;
}

export async function deleteCard(projectPath: string, cardId: string): Promise<{ ok: true }> {
  const { data, analysisResult, cards } = await readCards(projectPath);
  if (!cards.some((c) => c.id === cardId)) {
    throw new GenerationError('card_not_found', `卡片不存在: ${cardId}`);
  }
  const next = removeCardInResult(analysisResult, cardId);
  await deleteCardAssets(projectPath, cardId).catch(() => {});
  await new HeadlessProjectContext(projectPath).saveSection('aiAnalysis', {
    analysisResult: next,
    coverCandidates: data.aiAnalysis?.coverCandidates ?? [],
  });
  return { ok: true };
}

async function readSubtitleEntries(projectPath: string) {
  try {
    return parseSrt(await readFile(path.join(projectPath, 'podcast-subtitles.srt'), 'utf-8'));
  } catch {
    return [];
  }
}

function findOverlayForCard(data: Awaited<ReturnType<typeof loadProjectFile>>, cardId: string) {
  const overlays = data.timeline?.overlays ?? [];
  return overlays.find(
    (overlay) =>
      overlay.overlayType === 'ai-card' &&
      overlay.aiCardData?.sourceCardId === cardId,
  );
}

function findSegmentForCard(
  result: Awaited<ReturnType<typeof readCards>>['analysisResult'],
  card: AICard | null,
  segmentId?: string,
): AISegment | null {
  const id = segmentId || card?.segmentId;
  return result?.segments.find((segment) => segment.id === id) ?? null;
}

function getSegmentVisualType(segment: AISegment | null): AISegmentVisualType | undefined {
  return segment && 'visualType' in segment
    ? (segment as { visualType?: AISegmentVisualType }).visualType
    : undefined;
}

export async function getCardContext(
  projectPath: string,
  userDataPath: string,
  options: { cardId?: string; segmentId?: string; visualType?: AISegmentVisualType } = {},
) {
  const { data, analysisResult, cards } = await readCards(projectPath);
  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const entries = await readSubtitleEntries(projectPath);
  const card = options.cardId ? cards.find((c) => c.id === options.cardId) ?? null : null;
  if (options.cardId && !card) {
    throw new GenerationError('card_not_found', `卡片不存在: ${options.cardId}`);
  }
  const segment = findSegmentForCard(analysisResult, card, options.segmentId);
  if (options.segmentId && !segment) {
    throw new GenerationError('segment_not_found', `段落不存在: ${options.segmentId}`);
  }
  const resolvedStylePresetId = resolveStylePresetId({
    card: card?.stylePresetId,
    project: data.stylePresetId,
    global: settings.defaultStylePresetId,
  });
  const stylePreset = getStylePresetById(resolvedStylePresetId);
  const prompts = Object.fromEntries(
    await Promise.all(
      CARD_PROMPT_KINDS.map(async (kind) => {
        const template = await loadEffectivePromptTemplate(kind, {
          userDataPath,
          projectDir: projectPath,
        });
        return [kind, template];
      }),
    ),
  );
  const overlay = card ? findOverlayForCard(data, card.id) : null;
  const segmentStartMs = segment?.startMs ?? card?.startMs ?? 0;
  const segmentEndMs = segment?.endMs ?? card?.endMs ?? segmentStartMs;
  return {
    project: {
      path: projectPath,
      width: data.timeline?.width ?? 1920,
      height: data.timeline?.height ?? 1080,
      fps: data.timeline?.fps ?? 30,
      stylePresetId: data.stylePresetId ?? null,
      resolvedStylePresetId,
      promptBindings: projectBindings,
    },
    analysis: analysisResult
      ? {
          summary: analysisResult.summary,
          keywords: analysisResult.keywords,
          globalPrompt: analysisResult.globalPrompt ?? null,
          segmentCount: analysisResult.segments.length,
          cardCount: analysisResult.cards.length,
        }
      : null,
    segment: segment
      ? {
          ...segment,
          transcript: buildPlainTranscriptRange(entries, segment.startMs, segment.endMs),
          transcriptWithTiming: buildSrtTextRange(entries, segment.startMs, segment.endMs),
          cuesBlock: buildSegmentCuesBlock(entries, segment.startMs, segment.endMs),
        }
      : null,
    card,
    overlay: overlay ?? null,
    visualType: options.visualType ?? getSegmentVisualType(segment) ?? 'motion',
    style: {
      id: stylePreset.id,
      name: stylePreset.name,
      description: stylePreset.description,
      palette: stylePreset.palette,
      fonts: stylePreset.fonts,
      motionFacet: getStyleFacetBlock(resolvedStylePresetId, 'motion'),
      imageFacet: getStyleFacetBlock(resolvedStylePresetId, 'image'),
      coverFacet: getStyleFacetBlock(resolvedStylePresetId, 'cover'),
    },
    prompts,
  };
}

export async function validateCard(
  projectPath: string,
  cardId: string,
): Promise<{
  ok: boolean;
  cardId: string;
  type: AICard['type'];
  checks: unknown[];
}> {
  const { data, cards } = await readCards(projectPath);
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new GenerationError('card_not_found', `卡片不存在: ${cardId}`);
  const checks: unknown[] = [];

  if (card.renderMode === 'motion-card') {
    const tsx = card.motionCard?.tsx?.trim();
    if (!tsx) {
      checks.push({
        name: 'motion-render',
        ok: false,
        issues: [{ severity: 'error', code: 'missing-tsx', message: 'Motion Card 缺少 TSX 源码。' }],
      });
    } else {
      const entries = await readSubtitleEntries(projectPath);
      const overlay = findOverlayForCard(data, card.id);
      const cues =
        overlay && data.timeline
          ? computeCardCues(entries, overlay.startMs, overlay.durationMs, data.timeline.fps ?? 30)
          : [];
      const validation = await validateMotionCardTsx(tsx, {
        cues,
        cardAsset: (rel) => path.join(projectPath, rel),
      });
      const segment = findSegmentForCard(data.aiAnalysis?.analysisResult ?? null, card);
      checks.push({
        name: 'motion-render',
        ok: validation.ok,
        render: validation.render,
        issues: validation.issues,
        framesChecked: validation.framesChecked,
        cues,
        visualType: getSegmentVisualType(segment) ?? 'motion',
      });
    }
  }

  if (card.type === 'image' || card.type === 'video') {
    const content = card.content && typeof card.content === 'object' ? card.content : null;
    const assetPath = content && 'assetPath' in content ? content.assetPath : null;
    const fullAssetPath = typeof assetPath === 'string' ? path.join(projectPath, assetPath) : null;
    checks.push({
      name: 'media-asset',
      ok: Boolean(fullAssetPath && existsSync(fullAssetPath)),
      assetPath,
      issues: fullAssetPath
        ? existsSync(fullAssetPath)
          ? []
          : [{ severity: 'error', code: 'missing-media-file', message: `媒体文件不存在：${assetPath}` }]
        : [{ severity: 'error', code: 'missing-media-asset', message: '媒体卡片缺少 assetPath。' }],
    });
  }

  const overlay = findOverlayForCard(data, card.id);
  checks.push({
    name: 'timeline-overlay',
    ok: Boolean(overlay),
    overlayId: overlay?.id ?? null,
    issues: overlay
      ? []
      : [{ severity: 'error', code: 'missing-overlay', message: '卡片缺少对应 timeline ai-card overlay。' }],
  });

  const ok = !checks.some((check) =>
    Boolean(
      check &&
        typeof check === 'object' &&
        'ok' in check &&
        !(check as { ok?: boolean }).ok,
    ),
  );
  return { ok, cardId, type: card.type, checks };
}
