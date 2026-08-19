import type { SrtEntry } from '../types';
import type { AICard, AIAnalysisCardError, AIAnalysisResult, AISettings, AISegmentVisualType } from '../types/ai';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type DirectorPlan,
} from '../types/director';
import type { FootageCompositionInput } from '../types/footage';
import {
  generateCardForSegment,
  materializeImageCard,
  type AnalyzeSrtProgress,
  type GenerateCardImageFn,
} from './ai-analysis';
import { normalizeCardGenerationConcurrency } from '../types/ai';
import { syncDirectorPlanMotionBible } from './director-workflow';

type GenerateCard = typeof generateCardForSegment;
type CardOptions = NonNullable<Parameters<GenerateCard>[4]>;

export class DirectorApprovalRequiredError extends Error {
  readonly code = 'director_approval_required';

  constructor() {
    super('导演方案尚未批准，请先在导演台确认方案。');
    this.name = 'DirectorApprovalRequiredError';
  }
}

export interface GenerateCardsFromDirectorOptions {
  generateCard?: GenerateCard;
  generateCardImage?: GenerateCardImageFn;
  cardOptions?: CardOptions;
  existingCards?: AICard[];
  segmentIds?: string[];
  /**
   * 段级视觉形态覆盖（footage 轨未认领段的退路）：优先于 segment.visualType。
   * 由 director-production-tracks 的 footage 认领协调注入。
   */
  visualTypeOverrides?: ReadonlyMap<string, AISegmentVisualType>;
  renderStrategyOverrides?: ReadonlyMap<string, 'motion-card'>;
  /** agent-composite 每段已解析的真实素材输入。 */
  compositionInputs?: ReadonlyMap<string, FootageCompositionInput[]>;
  /** Renderer 制作暂停信号；每个 worker 在领取下一镜头前都会重新检查。 */
  shouldCancel?: () => boolean;
  /** 供直接调用方传入的标准取消信号，与 shouldCancel 等价。 */
  signal?: AbortSignal;
  onProgress?: (progress: AnalyzeSrtProgress) => void;
  onCardGenerated?: (card: AICard, index: number) => void | Promise<void>;
  now?: number;
}

export function isDirectorProductionCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === 'AbortError'
    || code === 'cancelled'
    || code === 'canceled';
}

function cancellationRequested(options: GenerateCardsFromDirectorOptions): boolean {
  return options.signal?.aborted === true || options.shouldCancel?.() === true;
}

function artifactFingerprint(plan: DirectorPlan, segmentId: string): string {
  const segment = plan.segments.find((item) => item.id === segmentId);
  const raw = JSON.stringify({
    revision: plan.revision,
    segment,
    thesis: plan.motionBible.visualThesis,
    rhythm: plan.motionBible.rhythm,
    style: plan.motionBible.styleRules,
  });
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) hash = Math.imul(31, hash) + raw.charCodeAt(index) | 0;
  return `card-${(hash >>> 0).toString(16)}`;
}

export async function generateCardsFromDirectorPlan(
  entries: SrtEntry[],
  plan: DirectorPlan,
  settings: AISettings,
  options: GenerateCardsFromDirectorOptions = {},
): Promise<AIAnalysisResult> {
  if (!plan.approvedAt) throw new DirectorApprovalRequiredError();
  const executionBible = syncDirectorPlanMotionBible(plan);
  const generateCard = options.generateCard ?? generateCardForSegment;
  const targetIds = options.segmentIds ? new Set(options.segmentIds) : null;
  const targets = plan.segments.filter((segment) => segment.enabled && (!targetIds || targetIds.has(segment.id)));
  const existing = new Map((options.existingCards ?? []).map((card) => [card.segmentId, card]));
  const slots = new Map<string, AICard>();
  const errors: AIAnalysisCardError[] = [];
  let cursor = 0;
  let completed = 0;
  let cancellationError: unknown = null;
  const now = options.now ?? Date.now();
  const runOne = async (): Promise<void> => {
    while (cursor < targets.length && !cancellationError) {
      // cursor 的读取和递增之间没有 await。先检查取消，再原子地领取一个镜头，
      // 可保证暂停后不会继续把剩余镜头批量塞进生成队列。
      if (cancellationRequested(options)) return;
      const index = cursor;
      cursor += 1;
      const segment = targets[index];
      let settled = false;
      try {
        const approvedRenderStrategy = resolveDirectorRenderStrategy(segment);
        const renderStrategy = options.renderStrategyOverrides?.get(segment.id)
          ?? approvedRenderStrategy;
        const fallbackPolicy = resolveDirectorFallbackPolicy(segment);
        const approvedMotionFallback = approvedRenderStrategy === 'agent-composite'
          && renderStrategy === 'motion-card'
          && fallbackPolicy === 'motion';
        const compositionInputs = options.compositionInputs?.get(segment.id) ?? [];
        const generationOptions: CardOptions = {
          ...options.cardOptions,
          globalPrompt: plan.globalPrompt,
          motionBible: executionBible,
          segmentIndex: index,
          totalSegments: targets.length,
          prevSegment: index > 0 ? targets[index - 1] : undefined,
          nextSegment: index + 1 < targets.length ? targets[index + 1] : undefined,
          // visualType describes the source medium; renderStrategy independently selects the producer.
          visualType: options.visualTypeOverrides?.get(segment.id)
            ?? (renderStrategy === 'standalone-media'
              ? segment.footageFallback ?? 'motion'
              : segment.visualType ?? 'motion'),
          renderStrategy,
          compositionIntent: segment.compositionIntent,
          ...(renderStrategy === 'agent-composite' || approvedMotionFallback
            ? { compositionInputs }
            : {}),
          fallbackPolicy: approvedMotionFallback ? 'block' : fallbackPolicy,
          approvedFallbackExecution: approvedMotionFallback ? 'motion' : undefined,
          qualityMode: 'director',
        };
        let card: AICard;
        try {
          card = await generateCard(entries, plan, segment, settings, generationOptions);
        } catch (error) {
          if (cancellationError || cancellationRequested(options) || isDirectorProductionCancellation(error)) throw error;
          if (renderStrategy !== 'agent-composite' || fallbackPolicy !== 'motion') throw error;
          card = await generateCard(entries, plan, segment, settings, {
            ...generationOptions,
            visualType: 'motion',
            renderStrategy: 'motion-card',
            compositionInputs: [],
            fallbackPolicy: 'block',
            approvedFallbackExecution: 'motion',
          });
        }
        if (cancellationError || cancellationRequested(options)) return;
        if (card.type === 'image' && options.generateCardImage) {
          options.onProgress?.({ phase: 'cards', percent: 0, message: `生成图片 ${index + 1}/${targets.length}` });
          card = await materializeImageCard(card, options.generateCardImage);
        }
        if (cancellationError || cancellationRequested(options)) return;
        const previous = existing.get(segment.id);
        card = {
          ...card,
          id: previous?.id ?? card.id,
          generationProvenance: {
            directorRevision: plan.revision,
            fingerprint: artifactFingerprint(plan, segment.id),
            generatedAt: now,
            modifiedByUser: false,
          },
        };
        slots.set(segment.id, card);
        await options.onCardGenerated?.(card, index);
        settled = true;
      } catch (error) {
        if (cancellationError || cancellationRequested(options) || isDirectorProductionCancellation(error)) {
          cancellationError ??= error;
          return;
        }
        errors.push({
          segmentId: segment.id,
          segmentTitle: segment.title,
          segmentIndex: index,
          totalSegments: targets.length,
          message: error instanceof Error ? error.message : String(error),
        });
        settled = true;
      } finally {
        if (settled) {
          completed += 1;
          options.onProgress?.({
            phase: 'cards',
            percent: targets.length > 0 ? Math.round((completed / targets.length) * 100) : 100,
            message: `生成内容卡片 ${completed}/${targets.length}`,
            cardIndex: completed,
            cardTotal: targets.length,
          });
        }
      }
    }
  };
  const concurrency = Math.min(normalizeCardGenerationConcurrency(settings.cardGenerationConcurrency), Math.max(1, targets.length));
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));
  if (cancellationError) throw cancellationError;
  const enabledSegmentIds = new Set(
    plan.segments.filter((segment) => segment.enabled).map((segment) => segment.id),
  );
  const untouched = (options.existingCards ?? []).filter(
    (card) => !slots.has(card.segmentId) && enabledSegmentIds.has(card.segmentId),
  );
  return {
    segments: plan.segments,
    cards: [...untouched, ...plan.segments.map((segment) => slots.get(segment.id)).filter((card): card is AICard => Boolean(card))]
      .sort((left, right) => left.startMs - right.startMs),
    coverPrompts: plan.coverDirection.prompt ? [plan.coverDirection.prompt] : [],
    summary: plan.summary,
    keywords: plan.keywords,
    globalPrompt: plan.globalPrompt,
    motionBible: executionBible,
    cardErrors: errors.length > 0 ? errors : undefined,
  };
}
