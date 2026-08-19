import type { SrtEntry } from '../types';
import type { AISettings, AISegmentAnalysis, PromptBindingMap } from '../types/ai';
import type { DirectorPlan, DirectorSegmentPlan } from '../types/director';
import type { MotionBible } from '../types/motion';
import type { VisualShotPurpose } from '../types/production';
import {
  generateMotionBible,
  planTranscriptSegments,
  type SegmentPlanningResult,
} from './ai-analysis';
import { alignCoverPromptTitle } from './cover-title';
import { createDirectorInputFingerprint } from './director-workflow';
import type { PromptTemplate } from './prompts';
import type { TelemetryHook } from './telemetry/auto-run';
import type { KacutLibraryDigest } from '../types/footage';

type PlanSegments = typeof planTranscriptSegments;
type GenerateBible = typeof generateMotionBible;

export interface CreateDirectorPlanOptions {
  revision?: number;
  globalPrompt?: string;
  stylePresetId?: string;
  /** 缺省为 true；false 时方案关闭背景音乐。 */
  bgmEnabled?: boolean;
  planningTemplate?: PromptTemplate;
  directorTemplate?: PromptTemplate;
  motionBibleTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  telemetry?: TelemetryHook;
  /** 素材库（KaCut）摘要 provider；未注入 / 返回 null 时 planning 不出现 footage 选项。 */
  kacutDigestProvider?: () => Promise<KacutLibraryDigest | null>;
  onProgress?: (phase: 'planning' | 'motion-bible', percent: number) => void;
  planSegments?: PlanSegments;
  generateBible?: GenerateBible;
  now?: number;
}

function purposeFor(
  segment: AISegmentAnalysis,
  mediaRole?: MotionBible['carrierPlan'][number]['mediaRole'],
): VisualShotPurpose {
  if (mediaRole === 'evidence') return 'evidence';
  if (mediaRole === 'context') return 'context';
  if (mediaRole === 'emotion') return 'breath';
  if (mediaRole === 'demonstration') return 'explain';
  if (segment.semanticType === 'data') return 'evidence';
  if (segment.semanticType === 'chapter-transition') return 'transition';
  if (segment.semanticType === 'quote') return 'emphasis';
  return 'explain';
}

function segmentPlan(segment: AISegmentAnalysis, bible: MotionBible): DirectorSegmentPlan {
  const directive = bible.carrierPlan.find((item) => item.segmentId === segment.id);
  const visualType = directive?.visualType ?? segment.visualType ?? 'motion';
  const renderStrategy = directive?.renderStrategy
    ?? (visualType === 'footage' ? 'standalone-media' : 'motion-card');
  return {
    ...segment,
    visualType,
    footageQuery: visualType === 'footage'
      ? directive?.mediaQuery ?? segment.footageQuery
      : undefined,
    footageFallback: visualType === 'footage'
      ? directive?.footageFallback ?? segment.footageFallback ?? 'motion'
      : undefined,
    enabled: true,
    purpose: purposeFor(segment, directive?.mediaRole),
    carrier: renderStrategy === 'agent-composite'
      ? directive?.preferredCarrier ?? 'concept'
      : visualType === 'motion'
      ? directive?.preferredCarrier ?? 'concept'
      : visualType,
    intensity: directive?.intensity ?? (segment.pacingNeed === 'accent' ? 3 : 2),
    renderStrategy,
    compositionIntent: renderStrategy === 'agent-composite'
      ? directive?.compositionIntent ?? {
          narrativeGoal: directive?.reason ?? segment.summary,
          focalPriority: segment.title,
          temporalRelationship: '',
          mustShow: [],
          avoid: [],
        }
      : undefined,
    fallbackPolicy: renderStrategy === 'agent-composite'
      ? directive?.fallbackPolicy ?? 'block'
      : undefined,
    composition: renderStrategy === 'agent-composite'
      ? undefined
      : directive?.composition ?? (visualType === 'motion' ? 'graphic' : 'full-bleed'),
    cameraMove: directive?.cameraMove ?? (visualType === 'motion' ? 'static' : 'push-in'),
    mediaRole: directive?.mediaRole ?? (segment.semanticType === 'data' ? 'evidence' : 'context'),
    transition: directive?.transition,
    rationale: directive?.reason ?? '根据段落语义和节奏自动分配。',
  };
}

function audioDirection(
  planning: SegmentPlanningResult,
  bible: MotionBible,
  bgmEnabled: boolean,
): DirectorPlan['audioDirection'] {
  const high = bible.rhythm.heavySegments.length;
  const energy: 1 | 2 | 3 = high > Math.max(2, planning.segments.length / 3) ? 3 : high === 0 ? 1 : 2;
  return {
    bgmEnabled,
    soundEffectsEnabled: true,
    bgmStyle: `克制、现代、为连续口播留出中频空间；围绕${planning.keywords.slice(0, 3).join('、') || '节目主题'}建立轻量氛围`,
    energy,
    soundDensity: bible.rhythm.density === 'quiet' ? 'quiet' : bible.rhythm.density === 'dense' ? 'active' : 'balanced',
  };
}

export async function createDirectorPlan(
  entries: SrtEntry[],
  settings: AISettings,
  options: CreateDirectorPlanOptions = {},
): Promise<DirectorPlan> {
  if (entries.length === 0) throw new Error('没有可用于生成导演方案的字幕内容');
  const planSegments = options.planSegments ?? planTranscriptSegments;
  const generateBible = options.generateBible ?? generateMotionBible;
  options.onProgress?.('planning', 0);
  const planning = await planSegments(entries, settings, {
    globalPrompt: options.globalPrompt,
    planningTemplate: options.planningTemplate,
    directorTemplate: options.directorTemplate,
    projectBindings: options.projectBindings,
    telemetry: options.telemetry,
    kacutDigestProvider: options.kacutDigestProvider,
  });
  options.onProgress?.('planning', 100);
  options.onProgress?.('motion-bible', 0);
  const bible = await generateBible(planning, settings, {
    motionBibleTemplate: options.motionBibleTemplate,
    directorTemplate: options.directorTemplate,
    projectBindings: options.projectBindings,
    telemetry: options.telemetry,
  });
  options.onProgress?.('motion-bible', 100);
  const now = options.now ?? Date.now();
  const summary = planning.summary.trim()
    || planning.segments
      .map((segment) => segment.summary.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('；')
    || planning.segments.find((segment) => segment.title.trim())?.title.trim()
    || '';
  const title = planning.title?.trim()
    || planning.segments.find((segment) => segment.title.trim())?.title.trim()
    || summary;
  const coverPrompt = planning.coverPrompts[0]
    ? alignCoverPromptTitle(planning.coverPrompts[0], title)
    : '';
  return {
    revision: options.revision ?? 1,
    inputFingerprint: createDirectorInputFingerprint({
      entries,
      globalPrompt: options.globalPrompt,
      stylePresetId: options.stylePresetId,
    }),
    title,
    summary,
    keywords: planning.keywords,
    globalPrompt: options.globalPrompt?.trim() || planning.globalPrompt,
    segments: planning.segments.map((segment) => segmentPlan(segment, bible)),
    motionBible: bible,
    coverDirection: {
      prompt: coverPrompt,
      composition: '16:9 横版，主体突出，标题避开主体并保持安全区',
    },
    audioDirection: audioDirection(planning, bible, options.bgmEnabled !== false),
    warnings: [
      ...(planning.warnings ?? []),
      ...(bible.warnings ?? []).map((warning) => warning.message),
    ],
    createdAt: now,
    updatedAt: now,
  };
}
