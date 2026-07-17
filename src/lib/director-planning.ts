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
import { createDirectorInputFingerprint } from './director-workflow';
import type { PromptTemplate } from './prompts';
import type { TelemetryHook } from './telemetry/auto-run';

type PlanSegments = typeof planTranscriptSegments;
type GenerateBible = typeof generateMotionBible;

export interface CreateDirectorPlanOptions {
  revision?: number;
  globalPrompt?: string;
  stylePresetId?: string;
  planningTemplate?: PromptTemplate;
  directorTemplate?: PromptTemplate;
  motionBibleTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  telemetry?: TelemetryHook;
  onProgress?: (phase: 'planning' | 'motion-bible', percent: number) => void;
  planSegments?: PlanSegments;
  generateBible?: GenerateBible;
  now?: number;
}

function purposeFor(segment: AISegmentAnalysis): VisualShotPurpose {
  if (segment.semanticType === 'data') return 'evidence';
  if (segment.semanticType === 'chapter-transition') return 'transition';
  if (segment.semanticType === 'quote') return 'emphasis';
  return 'explain';
}

function segmentPlan(segment: AISegmentAnalysis, bible: MotionBible): DirectorSegmentPlan {
  const directive = bible.carrierPlan.find((item) => item.segmentId === segment.id);
  return {
    ...segment,
    enabled: true,
    purpose: purposeFor(segment),
    carrier: directive?.preferredCarrier ?? (segment.visualType === 'image' ? 'image' : 'concept'),
    intensity: directive?.intensity ?? (segment.pacingNeed === 'accent' ? 3 : 2),
    rationale: directive?.reason ?? '根据段落语义和节奏自动分配。',
  };
}

function audioDirection(planning: SegmentPlanningResult, bible: MotionBible): DirectorPlan['audioDirection'] {
  const high = bible.rhythm.heavySegments.length;
  const energy: 1 | 2 | 3 = high > Math.max(2, planning.segments.length / 3) ? 3 : high === 0 ? 1 : 2;
  return {
    bgmEnabled: true,
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
  return {
    revision: options.revision ?? 1,
    inputFingerprint: createDirectorInputFingerprint({
      entries,
      globalPrompt: options.globalPrompt,
      stylePresetId: options.stylePresetId,
    }),
    summary: planning.summary,
    keywords: planning.keywords,
    globalPrompt: options.globalPrompt?.trim() || planning.globalPrompt,
    segments: planning.segments.map((segment) => segmentPlan(segment, bible)),
    motionBible: bible,
    coverDirection: {
      prompt: planning.coverPrompts[0] ?? '',
      composition: '16:9 横版，主体突出，标题避开主体并保持安全区',
    },
    audioDirection: audioDirection(planning, bible),
    warnings: (bible.warnings ?? []).map((warning) => warning.message),
    createdAt: now,
    updatedAt: now,
  };
}
