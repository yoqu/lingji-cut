import type { WorkbenchStage } from './script-workbench-stage';
import type { TimelineData } from '../types';
import type { AIAnalysisResult, CoverCandidate } from '../types/ai';
import type { AutoWorkflowParams } from '../store/ai';
import type { MotionProductionPlan } from '../types/production';
import type { ProjectProductionState } from '../types/director';
import { createEmptyProductionState, migrateLegacyProductionState } from './director-workflow';

export interface ProjectScriptState {
  templateId: string;
  annotations: unknown[];
  reviewState: 'idle' | 'issues' | 'clean';
  lastReviewedDocVersion: number;
  manualStageOverride?: WorkbenchStage | null;
}

export interface ProjectAIAnalysis {
  analysisResult: AIAnalysisResult | null;
  coverCandidates: CoverCandidate[];
}

/**
 * AI 一键全量剪辑运行元数据。
 * 仅用于 Editor 顶部的"恢复横幅"：记住上次 autoMode 使用的 template/role/voice，
 * 以便用户关闭/重启应用后依然能从中断点继续。
 * 实际"走到哪一步"靠磁盘产物推断，不依赖此字段。
 */
export interface ProjectWorkflowMeta {
  lastAutoParams: AutoWorkflowParams | null;
  lastAutoRunAt: string | null;
  /**
   * 上次 TTS 成功时使用的口播文稿内容哈希。
   * 用于 Editor 顶部的"文稿已修改"提示：若当前 script.md 哈希与此值不一致，
   * 说明用户在写稿工作台改过文稿但还没重新生成口播音频与字幕。
   * null 代表当前项目的口播音频不是由本应用 TTS 生成（或尚未跑过），此时不显示提示。
   */
  lastPodcastScriptHash: string | null;
}

/** 单个发布账号的文案覆盖（与发布工作台的 AccountOverride 同构）。 */
export interface ProjectPublishOverride {
  title: string;
  desc: string;
  tagsInput: string;
  bilibiliTid: string;
}

/** 发布历史保留的最大条数（新→旧，超出淘汰）。 */
export const PUBLISH_HISTORY_MAX = 20;

/** 一条发布历史记录的单账号结果（最终态）。 */
export interface PublishHistoryResult {
  state: 'success' | 'failed';
  message?: string;
}

/** 一条发布历史的目标账号快照（用于展示与重新发布）。 */
export interface PublishHistoryTarget {
  accountId: string;
  platform: string;
  accountName: string;
  /** B站分区 id（仅 B站）。 */
  bilibiliTid?: number;
}

/**
 * 一次发布任务的历史记录。按发布任务粒度，含各账号最终结果。
 * 保存足够字段以支持「重新发布」（filePath + shared + targets）。
 */
export interface PublishHistoryEntry {
  id: string;
  /** 发布发起时间戳（毫秒）。 */
  publishedAt: number;
  /** basename(filePath)，列表展示用。 */
  fileName: string;
  filePath: string;
  shared: {
    title: string;
    desc: string;
    tags: string[];
    thumbnail?: string;
    covers?: Partial<Record<'16:9' | '4:3' | '3:4', string>>;
    bilibiliTid?: number;
  };
  targets: PublishHistoryTarget[];
  /** 按 accountId 映射的最终结果。 */
  results: Record<string, PublishHistoryResult>;
  overallState: 'success' | 'partial' | 'failed';
}

/**
 * 发布选项卡的文案元数据。
 * AI 生成或手动填写的标题 / 描述 / 标签 / 封面随项目持久化，
 * 重开项目时自动回填，避免用户每次都要重新生成。
 */
export interface ProjectPublishMeta {
  title: string;
  desc: string;
  /** 标签原始输入串（逗号分隔），原样存储以无损回填。 */
  tagsInput: string;
  thumbnail: string;
  /** 多比例发布封面（16:9 / 4:3 / 3:4），缺省视为未选。 */
  covers?: Partial<Record<'16:9' | '4:3' | '3:4', string>>;
  /** B站分区 ID（tid，B站必填，全平台共享）。 */
  bilibiliTid?: string;
  /** 发布历史（新→旧，最多 PUBLISH_HISTORY_MAX 条）；缺省视为空。 */
  history?: PublishHistoryEntry[];
  /** 已成功发布的平台 → 最近一次成功发布时间戳（毫秒）；累积不淘汰，作为「已发布」标记真源。 */
  publishedPlatforms?: Record<string, number>;
  /** @deprecated 已移除按账号文案覆盖，仅保留以兼容旧工程读取。 */
  overrides?: Record<string, ProjectPublishOverride>;
}

/** 作品级元信息。title 是作品标题唯一真源；发布/封面/流水线均引用它。 */
export interface ProjectMetaSection {
  title: string;
}

export interface ProjectData {
  version: 3;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineData | null;
  aiAnalysis: ProjectAIAnalysis;
  script: ProjectScriptState;
  workflowMeta?: ProjectWorkflowMeta;
  /** 发布选项卡文案元数据；缺省视为空。 */
  publish?: ProjectPublishMeta;
  /** 作品级元信息（标题真源）；缺省视为空。 */
  meta?: ProjectMetaSection;
  /** 项目级默认风格预设 id；缺省继承全局 */
  stylePresetId?: string;
  /** 导演方案、制作执行与审核状态的单一真源。 */
  production?: ProjectProductionState;
}

export type ProjectSection =
  | 'timeline'
  | 'aiAnalysis'
  | 'script'
  | 'workflowMeta'
  | 'publish'
  | 'meta'
  | 'stylePresetId'
  | 'production';

export const DEFAULT_WORKFLOW_META: ProjectWorkflowMeta = {
  lastAutoParams: null,
  lastAutoRunAt: null,
  lastPodcastScriptHash: null,
};

export const DEFAULT_PUBLISH_META: ProjectPublishMeta = {
  title: '',
  desc: '',
  tagsInput: '',
  thumbnail: '',
  bilibiliTid: '',
};

export const DEFAULT_PROJECT_META: ProjectMetaSection = {
  title: '',
};

/** 单调递增时间戳，保证在同一毫秒内多次调用也不重复 */
let _lastTimestamp = '';
function nowIso(): string {
  let ts = new Date().toISOString();
  if (ts <= _lastTimestamp) {
    // 在同毫秒内追加微秒偏移，保证不重复
    const base = _lastTimestamp.replace(/\.(\d+)Z$/, (_, ms) => `.${String(Number(ms) + 1).padStart(ms.length, '0')}Z`);
    ts = base;
  }
  _lastTimestamp = ts;
  return ts;
}

export function createDefaultProjectData(): ProjectData {
  const now = nowIso();
  return {
    version: 3,
    createdAt: now,
    updatedAt: now,
    timeline: null,
    aiAnalysis: {
      analysisResult: null,
      coverCandidates: [],
    },
    script: {
      templateId: 'news-broadcast',
      annotations: [],
      reviewState: 'idle',
      lastReviewedDocVersion: 0,
    },
    workflowMeta: { ...DEFAULT_WORKFLOW_META },
  };
}

/**
 * V1/V2 -> V3：保留原项目内容，并把旧 production/analysis 恢复为受保护的导演版本。
 */
export function migrateProjectData(input: Omit<ProjectData, 'version' | 'production'> & {
  version?: number;
  production?: ProjectProductionState | MotionProductionPlan;
}): {
  data: ProjectData;
  migrated: boolean;
} {
  const productionVersion = input.production?.version;
  if (input.version === 3 && (productionVersion == null || productionVersion === 3)) {
    return { data: input as ProjectData, migrated: false };
  }
  const legacyProduction = input.production && input.production.version === 2
    ? input.production as MotionProductionPlan
    : null;
  const existingV3 = input.production && input.production.version === 3
    ? input.production as ProjectProductionState
    : null;
  const production = existingV3 ?? (
    input.aiAnalysis?.analysisResult?.segments?.length
      ? migrateLegacyProductionState({
          analysisResult: input.aiAnalysis.analysisResult,
          legacyPlan: legacyProduction,
          timeline: input.timeline ?? null,
          mode: input.workflowMeta?.lastAutoParams?.productionMode === 'director' ? 'director' : 'auto',
        })
      : legacyProduction
        ? {
            ...createEmptyProductionState(),
            execution: legacyProduction,
            legacyProtected: true,
          }
        : undefined
  );
  return {
    data: {
      ...input,
      version: 3,
      aiAnalysis: input.aiAnalysis ?? { analysisResult: null, coverCandidates: [] },
      script: input.script ?? {
        templateId: 'news-broadcast',
        annotations: [],
        reviewState: 'idle',
        lastReviewedDocVersion: 0,
      },
      ...(production ? { production } : {}),
    } as ProjectData,
    migrated: true,
  };
}

export function extractTimelineSection(data: ProjectData): TimelineData | null {
  return data.timeline;
}

export function extractAIAnalysisSection(data: ProjectData): ProjectAIAnalysis {
  return data.aiAnalysis;
}

export function extractScriptSection(data: ProjectData): ProjectScriptState {
  return data.script;
}

export function extractWorkflowMetaSection(data: ProjectData): ProjectWorkflowMeta {
  return data.workflowMeta ?? { ...DEFAULT_WORKFLOW_META };
}

export function extractPublishSection(data: ProjectData): ProjectPublishMeta {
  return { ...DEFAULT_PUBLISH_META, ...(data.publish ?? {}) };
}

export function extractMetaSection(data: ProjectData): ProjectMetaSection {
  return { ...DEFAULT_PROJECT_META, ...(data.meta ?? {}) };
}

/**
 * 已发布平台（平台 id → 最近成功时间戳）。
 * 真源是 publish.publishedPlatforms；旧工程无此字段时从发布历史的成功结果回推。
 */
export function resolvePublishedPlatforms(
  data: Pick<ProjectData, 'publish'>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const entry of data.publish?.history ?? []) {
    for (const target of entry.targets) {
      if (entry.results[target.accountId]?.state !== 'success') continue;
      resolved[target.platform] = Math.max(resolved[target.platform] ?? 0, entry.publishedAt);
    }
  }
  return { ...resolved, ...(data.publish?.publishedPlatforms ?? {}) };
}

/** 作品标题：meta.title 为真源，旧工程回退 publish.title（惰性迁移）。 */
export function resolveWorkTitle(data: ProjectData): string {
  return data.meta?.title?.trim() || data.publish?.title?.trim() || '';
}

export function mergeProjectSection<S extends ProjectSection>(
  data: ProjectData,
  section: S,
  value: ProjectData[S],
): ProjectData {
  return {
    ...data,
    [section]: value,
    updatedAt: nowIso(),
  };
}
