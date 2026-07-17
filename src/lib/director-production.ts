import type { SrtEntry } from '../types';
import type { AICard, AIAnalysisCardError, AIAnalysisResult, AISettings } from '../types/ai';
import type { DirectorPlan } from '../types/director';
import {
  generateCardForSegment,
  materializeImageCard,
  type AnalyzeSrtProgress,
  type GenerateCardImageFn,
} from './ai-analysis';
import { normalizeCardGenerationConcurrency } from '../types/ai';

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
  onProgress?: (progress: AnalyzeSrtProgress) => void;
  onCardGenerated?: (card: AICard, index: number) => void | Promise<void>;
  now?: number;
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
  const generateCard = options.generateCard ?? generateCardForSegment;
  const targetIds = options.segmentIds ? new Set(options.segmentIds) : null;
  const targets = plan.segments.filter((segment) => segment.enabled && (!targetIds || targetIds.has(segment.id)));
  const existing = new Map((options.existingCards ?? []).map((card) => [card.segmentId, card]));
  const slots = new Map<string, AICard>();
  const errors: AIAnalysisCardError[] = [];
  let cursor = 0;
  let completed = 0;
  const now = options.now ?? Date.now();
  const runOne = async (): Promise<void> => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const segment = targets[index];
      try {
        let card = await generateCard(entries, plan, segment, settings, {
          ...options.cardOptions,
          globalPrompt: plan.globalPrompt,
          motionBible: plan.motionBible,
          segmentIndex: index,
          totalSegments: targets.length,
          prevSegment: index > 0 ? targets[index - 1] : undefined,
          nextSegment: index + 1 < targets.length ? targets[index + 1] : undefined,
          visualType: segment.visualType,
          qualityMode: 'director',
        });
        if (card.type === 'image' && options.generateCardImage) {
          options.onProgress?.({ phase: 'cards', percent: 0, message: `生成图片 ${index + 1}/${targets.length}` });
          card = await materializeImageCard(card, options.generateCardImage);
        }
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
      } catch (error) {
        errors.push({
          segmentId: segment.id,
          segmentTitle: segment.title,
          segmentIndex: index,
          totalSegments: targets.length,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
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
  };
  const concurrency = Math.min(normalizeCardGenerationConcurrency(settings.cardGenerationConcurrency), Math.max(1, targets.length));
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));
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
    motionBible: plan.motionBible,
    cardErrors: errors.length > 0 ? errors : undefined,
  };
}
