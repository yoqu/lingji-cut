/**
 * footage 轨（素材库画面）共享类型。
 *
 * 数据来源是另一个本机 App（灵机素材 / KaCut）在 127.0.0.1:8765 提供的
 * 真 MCP 服务（JSON-RPC 2.0 over HTTP POST /mcp?token=...）。本文件同时被
 * electron 主进程（kacut-client）、preload 与 renderer lib 层引用，
 * 不依赖任何一侧运行时。
 */

/** KaCut 素材类别（search_clips 的 kind 过滤值）。 */
export type KacutClipKind = 'image' | 'video' | 'audio' | 'gif';

/** search_clips 返回的单条素材（字段名与 MCP 契约严格一致）。 */
export interface KacutClip {
  id: string;
  filename: string;
  /** 素材在本机的绝对路径。 */
  path: string;
  kind: KacutClipKind;
  /** 匹配分 0-1。 */
  score: number;
  reason?: string;
  percent?: number;
  durationSec?: number;
  thumbnailFile?: string;
  /** 视频片段级匹配锚点（秒）：源视频内与 query 最相关的起点。 */
  matchedSegmentStart?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface KacutSearchClipsArgs {
  query: string;
  limit?: number;
  kind?: KacutClipKind;
  minDurationSec?: number;
  maxDurationSec?: number;
}

/**
 * 导演审核时人工确认的素材。它随 DirectorPlan 持久化，批准制作后直接采用，
 * 不再经过自动匹配阈值或二次检索。
 */
export interface SelectedFootageAsset {
  id: string;
  filename: string;
  path: string;
  kind: 'video' | 'image';
  score: number;
  durationSec?: number;
  thumbnailFile?: string;
  matchedSegmentStart?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

/** 导演为组合镜头锁定的单个真实素材输入。 */
export interface DirectorCompositionAsset {
  asset: SelectedFootageAsset;
  usage: 'required' | 'optional';
  /** 覆盖素材匹配锚点的裁剪起点（毫秒）。 */
  trimStartMs?: number;
}

/**
 * 交给卡片 Agent 的真实素材输入。组合素材只进入卡片内部合成，不生成独立时间线 overlay。
 */
export interface FootageCompositionInput extends DirectorCompositionAsset {
  segmentIndex: number;
  segmentId: string;
  startMs: number;
  durationMs: number;
  /** 批准素材进入制作时冻结的 stat:size:mtime 指纹；缺失的旧产物不得复用。 */
  fileFingerprint?: string;
}

/** get_library_digest 返回的素材库摘要（注入 planning prompt 用）。 */
export interface KacutLibraryDigest {
  libraryCount: number;
  itemCount: number;
  indexedItemCount: number;
  kindCounts: Partial<Record<KacutClipKind, number>> & Record<string, number>;
  topSceneTags: Array<{ tag: string; count: number }>;
  /**
   * 素材库完整标签目录。旧版素材服务可能缺失，此时导演回退读取 topSceneTags。
   * 这里只包含聚合统计，不包含素材路径、OCR、ASR 或条目明细。
   */
  sceneTagCatalog?: Array<{
    tag: string;
    count: number;
    kindCounts: Partial<Record<KacutClipKind, number>> & Record<string, number>;
  }>;
  libraries: Array<{ id: string; name: string; itemCount: number }>;
}

/** footage 单段匹配决策；'none' 表示无结果 / 无法检索（退回 motion 卡）。 */
export type FootageMatchDecision = 'adopt' | 'fallback-image' | 'fallback-motion' | 'none';

/** 一次成功认领的素材上屏放置。 */
export interface FootagePlacement {
  segmentIndex: number;
  segmentId: string;
  overlayId: string;
  /** 段起点（时间线毫秒）。 */
  startMs: number;
  /** 段长（毫秒）。 */
  durationMs: number;
  /** 素材绝对路径（KaCut 库内文件）。 */
  sourcePath: string;
  /** 生成 placement 时冻结的源文件指纹；导出和恢复制作前必须复核。 */
  fileFingerprint?: string;
  kind: 'video' | 'image';
  /** 源视频裁剪起点（毫秒）= (matchedSegmentStart ?? 0) * 1000；图片恒为 0。 */
  trimStartMs: number;
  score: number;
  thumbnailFile?: string;
  composition?: import('./motion').MotionDirectiveComposition;
  cameraMove?: import('./motion').MotionDirectiveCameraMove;
  mediaRole?: import('./motion').MotionDirectiveMediaRole;
}

/** 未被 footage 认领的段：交给 cards 轨按该视觉形态出卡。 */
export interface FootageFallbackPlan {
  segmentId: string;
  visualType: 'image' | 'motion';
  /** 素材路由降级后实际进入卡片管线；旧产物缺失时沿用原行为。 */
  renderStrategy?: 'motion-card';
}

/** footage 轨一次运行的完整结果（新鲜检索或从持久化恢复，形状一致）。 */
export interface FootageTrackResult {
  /** 本轮执行了素材轨（自动检索或采用人工选择）；false 表示无 footage 段 / legacy 保护 / 直接复用持久化。 */
  ran: boolean;
  /** 结果来自持久化产物恢复（未重新检索）。 */
  reused?: boolean;
  /** KaCut 不可用（健康检查失败）：整轨跳过，全部 footage 段走退路。 */
  unavailable?: boolean;
  error?: string;
  /** 仅 standalone-media 路由的独立时间线放置；agent-composite 素材不得进入此数组。 */
  placements: FootagePlacement[];
  /** agent-composite 路由交给卡片 Agent 的素材；旧产物缺失时按空数组处理。 */
  compositionInputs?: FootageCompositionInput[];
  /** 被 footage 成功认领的段（cards 轨跳过这些段）。 */
  claimedSegmentIds: string[];
  /** 未认领段的出卡退路（cards 轨按此视觉形态生成）。 */
  fallbacks: FootageFallbackPlan[];
  /** fallbackPolicy=block 且缺少可用组合素材的段；不得继续生成纯 Motion 卡。 */
  blockedSegmentIds?: string[];
}

export const EMPTY_FOOTAGE_TRACK_RESULT: FootageTrackResult = {
  ran: false,
  placements: [],
  compositionInputs: [],
  claimedSegmentIds: [],
  fallbacks: [],
};
