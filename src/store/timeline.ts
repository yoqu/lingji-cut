import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type {
  AssetItem,
  AssetType,
  OverlayItem,
  SrtEntry,
  SubtitleHighlight,
  SubtitleStyle,
  TimelineData,
  TimelineTrack,
} from '../types';
import {
  DEFAULT_VISUAL_TRACK_ID,
  DEFAULT_AI_CARDS_TRACK_ID,
  createDefaultTimeline,
  createVisualTrack,
} from '../types';
import type { AICardTimelineDraft } from '../types/ai';
import { getFileNameFromPath } from '../lib/utils';
import { isAiEditLocked } from './ai-edit';
import {
  getAudioOverlayTracks,
  getNextAudioOverlayTrack,
  getNextVisualTrack,
  normalizeTimelineData,
} from '../lib/timeline-tracks';
import { getAICardOverlayPosition, isFullscreenAICardPosition } from '../lib/ai-card-layout';
import {
  clampOverlayDurationByNeighbors,
  canPlaceAt,
  isOverlayTrackManaged,
} from '../lib/timeline-placement';
import { resegmentSrtEntries } from '../lib/srt-resegment';
import { remapHighlightsAfterResegment } from '../lib/subtitle-highlights';
import { getProductionSaveGuard } from '../lib/production-save-guard';

type OverlayDraft = Omit<OverlayItem, 'id'>;
type TimelineSnapshot = TimelineData;
type TimelineCommitState = Pick<TimelineStore, 'timeline' | 'assets' | 'historyPast'>;
type OverlayClipboardMode = 'copy' | 'cut';
type OverlayClipboardItem = OverlayDraft & { mode: OverlayClipboardMode };

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** 聚合多路保存状态：error > saving > saved > 首路状态。状态栏用。 */
export function mergeSaveStatus(a: SaveStatus, b: SaveStatus): SaveStatus {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'saving' || b === 'saving') return 'saving';
  if (a === 'saved' || b === 'saved') return 'saved';
  return a;
}

export interface TimelineStore {
  timeline: TimelineData;
  srtEntries: SrtEntry[];
  originalSrtEntries: SrtEntry[];
  /** 仅用于使预览重新加载被同名覆盖的口播文件，不写入 project.json。 */
  podcastRevision: number;
  assets: AssetItem[];
  overlayClipboard: OverlayClipboardItem | null;
  canUndo: boolean;
  canRedo: boolean;
  subtitleSelection: number[];
  setSubtitleSelection: (indices: number[]) => void;
  clearSubtitleSelection: () => void;
  setTimeline: (timeline: TimelineData) => void;
  /** 整体替换 timeline（外部 project.json 变更热重载用，不进 undo 历史） */
  applyExternalTimeline: (timeline: TimelineData) => void;
  /** 外部 motionCard.tsx 变更：更新对应 overlay 的内存源码并清除旧编译错误，触发预览重编译 */
  applyExternalCardSource: (overlayId: string, tsx: string) => void;
  setSrtEntries: (entries: SrtEntry[]) => void;
  setSubtitleHighlights: (highlights: SubtitleHighlight[]) => void;
  clearSubtitleHighlights: () => void;
  updateSubtitleStyle: (updates: Partial<SubtitleStyle>) => void;
  setSubtitleMaxChars: (n: number) => void;
  resegmentSubtitles: () => { droppedHighlights: number };
  restoreOriginalSubtitles: () => void;
  setAutoResegment: (enabled: boolean) => void;
  setPodcast: (audioPath: string, srtPath: string, durationMs: number) => void;
  setGlobalBackground: (path: string) => void;
  addAsset: (path: string, type: AssetType, durationMs?: number) => void;
  addAssets: (items: { path: string; type: AssetType; durationMs?: number }[]) => void;
  removeAsset: (path: string) => void;
  addTrack: () => string;
  createTrackAt: (
    position: 'top' | 'bottom' | { kind: 'gap'; gapIndex: number },
  ) => string;
  toggleTrackLocked: (trackId: string) => void;
  removeTrack: (id: string) => void;
  addOverlay: (overlay: OverlayDraft) => string;
  addAICardsToTimeline: (cards: AICardTimelineDraft[]) => void;
  replaceAICardsOnTimeline: (
    cards: AICardTimelineDraft[],
    sourceCardIds: string[],
    options?: {
      skipAutosave?: boolean;
      /**
       * 制作提交时同批替换的 footage 素材 overlay：与同一次 set() 内移除全部
       * 旧 footage overlay（footageData 标记）并按 startMs 并入新批次，
       * 保证卡片 + 素材的原子替换只产生一条撤销历史。
       */
      footageOverlays?: OverlayItem[];
    },
  ) => void;
  appendAICardToTimeline: (
    card: AICardTimelineDraft,
    options?: { coalesceHistory?: boolean },
  ) => void;
  removeAICardOverlaysBySourceIds: (sourceCardIds: string[]) => void;
  copyOverlay: (id: string) => boolean;
  cutOverlay: (id: string) => boolean;
  pasteOverlay: (options: { trackId: string; startMs: number }) => string | null;
  updateOverlay: (id: string, updates: Partial<OverlayItem>) => void;
  trimOverlayClip: (id: string, edge: 'start' | 'end', newEdgeMs: number) => void;
  splitOverlayClipsAt: (playheadMs: number, targetIds?: string[]) => void;
  removeOverlay: (id: string) => void;
  removeOverlaysByIds: (
    ids: string[],
    options?: { ignoreTrackLock?: boolean },
  ) => void;
  undo: () => void;
  redo: () => void;
  historyPast: TimelineSnapshot[];
  historyFuture: TimelineSnapshot[];
}

const PROJECT_DIR_KEY = 'podcast-editor-project-dir';
const MAX_TIMELINE_HISTORY = 40;
// 标记上一次提交是否为「合并历史」的 AI 卡片增量 append。
// 用于让一轮分析里连续的 appendAICardToTimeline({ coalesceHistory: true })
// 折叠成单一撤销点：第一张推一次历史快照，后续张不再推。
// 任意普通提交（buildCommittedTimelineState）都会把它清零，于是下一轮重新建点。
let lastCommitWasCoalescedAICardAppend = false;
let currentSaveStatus: SaveStatus = 'idle';
const saveStatusListeners = new Set<(status: SaveStatus) => void>();

const buildAsset = (
  path: string,
  type: AssetType,
  durationMs = type === 'image' || type === 'text' ? 5000 : 10000,
  locked = false,
): AssetItem => ({
  path,
  type,
  name: getFileNameFromPath(path),
  durationMs,
  ...(locked ? { locked: true } : {}),
});

const dedupeAssets = (assets: AssetItem[]): AssetItem[] => {
  const assetMap = new Map<string, AssetItem>();

  for (const asset of assets) {
    assetMap.set(asset.path, asset);
  }

  return [...assetMap.values()];
};

function isMediaOverlay(overlay: OverlayItem): boolean {
  return overlay.overlayType !== 'ai-card' && Boolean(overlay.assetPath);
}

function getDefaultBackgroundDuration(timeline: TimelineData): number {
  return Math.max(1_000, timeline.podcast.durationMs || 5_000);
}

function getDefaultBackgroundTrackId(timeline: TimelineData): string {
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  const visualTracks = tracks.filter((track) => track.kind === 'visual');

  if (visualTracks.length === 0) {
    return DEFAULT_VISUAL_TRACK_ID;
  }

  return [...visualTracks]
    .sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }

      return left.id.localeCompare(right.id);
    })[0]
    .id;
}

function normalizeDefaultBackgroundOverlays(timeline: TimelineData): TimelineData {
  const overlays = Array.isArray(timeline.overlays) ? timeline.overlays : [];
  const hasDefaultBackground = overlays.some(
    (overlay) => overlay.overlayRole === 'default-background',
  );

  if (!hasDefaultBackground) {
    return timeline;
  }

  const trackId = getDefaultBackgroundTrackId(timeline);
  const durationMs = getDefaultBackgroundDuration(timeline);

  return {
    ...timeline,
    overlays: overlays.map((overlay) =>
      overlay.overlayRole === 'default-background'
        ? {
            ...overlay,
            type: 'image',
            trackId,
            startMs: 0,
            durationMs,
            position: {
              x: 0,
              y: 0,
              width: timeline.width,
              height: timeline.height,
            },
          }
        : overlay,
    ),
  };
}

const buildPodcastAssets = (timeline: TimelineData): AssetItem[] => {
  const assets: AssetItem[] = [];

  if (timeline.podcast.audioPath) {
    assets.push(buildAsset(timeline.podcast.audioPath, 'audio', timeline.podcast.durationMs, true));
  }

  if (timeline.podcast.srtPath) {
    assets.push(buildAsset(timeline.podcast.srtPath, 'srt', timeline.podcast.durationMs, true));
  }

  return assets;
};

const deriveAssetsFromTimeline = (timeline: TimelineData): AssetItem[] => {
  return dedupeAssets(
    [
      ...buildPodcastAssets(timeline),
      ...timeline.overlays.filter(isMediaOverlay).map((overlay) =>
        buildAsset(overlay.assetPath, overlay.type, overlay.durationMs),
      ),
    ],
  );
};

const syncAssetsWithTimeline = (assets: AssetItem[], timeline: TimelineData): AssetItem[] => {
  const persistentAssets = assets.filter(
    (asset) =>
      !asset.locked &&
      asset.path !== timeline.podcast.audioPath &&
      asset.path !== timeline.podcast.srtPath &&
      !timeline.overlays.some((overlay) => isMediaOverlay(overlay) && overlay.assetPath === asset.path),
  );

  return dedupeAssets([...persistentAssets, ...deriveAssetsFromTimeline(timeline)]);
};

const cloneTimeline = (timeline: TimelineData): TimelineData =>
  JSON.parse(JSON.stringify(timeline)) as TimelineData;

const cloneOverlayDraft = <T extends OverlayDraft>(overlay: T): T =>
  JSON.parse(JSON.stringify(overlay)) as T;

function buildOverlayClipboardItem(overlay: OverlayItem): OverlayClipboardItem {
  const { id: _id, ...draft } = overlay;
  return {
    ...cloneOverlayDraft(draft),
    mode: 'copy',
  };
}

const normalizeTimeline = (timeline: TimelineData): TimelineData =>
  normalizeTimelineData(cloneTimeline(normalizeDefaultBackgroundOverlays(timeline)));

const pushHistorySnapshot = (
  past: TimelineSnapshot[],
  timeline: TimelineData,
): TimelineSnapshot[] => [...past.slice(-(MAX_TIMELINE_HISTORY - 1)), cloneTimeline(timeline)];

function buildCommittedTimelineState(
  state: TimelineCommitState,
  nextTimeline: TimelineData,
  options?: {
    assetSource?: AssetItem[];
    overlayClipboard?: OverlayClipboardItem | null;
  },
) {
  const assetSource = options?.assetSource ?? state.assets;

  // 任意普通提交都结束当前的 coalesce 运行：下一次合并 append 会重新建立撤销点。
  lastCommitWasCoalescedAICardAppend = false;

  return {
    historyPast: pushHistorySnapshot(state.historyPast, state.timeline),
    historyFuture: [],
    canUndo: true,
    canRedo: false,
    timeline: nextTimeline,
    assets: syncAssetsWithTimeline(assetSource, nextTimeline),
    ...(options && 'overlayClipboard' in options
      ? { overlayClipboard: options.overlayClipboard ?? null }
      : {}),
  };
}

function resolveOverlayInsert(
  state: TimelineCommitState,
  draft: OverlayItem,
): { overlay: OverlayItem; createdTrack?: TimelineTrack } {
  if (!isOverlayTrackManaged(draft)) {
    return { overlay: draft };
  }

  // 音频 overlay：先确认目标轨存在；不存在则挑一条可用或新建
  if (draft.type === 'audio') {
    const audioTracks = getAudioOverlayTracks(state.timeline.tracks);
    const targetTrack = audioTracks.find((track) => track.id === draft.trackId);

    if (targetTrack) {
      const placement = canPlaceAt({
        trackId: targetTrack.id,
        startMs: draft.startMs,
        durationMs: draft.durationMs,
        overlays: state.timeline.overlays,
      });
      if (placement.ok) {
        return { overlay: draft };
      }
    }

    for (const track of audioTracks) {
      if (track.id === draft.trackId) continue;
      const retry = canPlaceAt({
        trackId: track.id,
        startMs: draft.startMs,
        durationMs: draft.durationMs,
        overlays: state.timeline.overlays,
      });
      if (retry.ok) {
        return { overlay: { ...draft, trackId: track.id } };
      }
    }
    const newAudioTrack = getNextAudioOverlayTrack(state.timeline.tracks);
    return {
      overlay: { ...draft, trackId: newAudioTrack.id },
      createdTrack: newAudioTrack,
    };
  }

  const placement = canPlaceAt({
    trackId: draft.trackId,
    startMs: draft.startMs,
    durationMs: draft.durationMs,
    overlays: state.timeline.overlays,
  });

  if (placement.ok) {
    return { overlay: draft };
  }

  // paste/addOverlay 链路保留"自动新建 visual 轨道"的退路（没有 UI 拖拽反馈）
  const newTrack = getNextVisualTrack(state.timeline.tracks);
  return {
    overlay: { ...draft, trackId: newTrack.id },
    createdTrack: newTrack,
  };
}

/**
 * 把单张 AI 卡片草稿应用到一组工作中的 tracks / overlays 上。
 *
 * 这是 addAICardsToTimeline（批量）与 appendAICardToTimeline（单张增量）共用的
 * 唯一插入逻辑：保证轨道选择、按 sourceCardId 去重 / 复用、默认位置计算完全一致，
 * 避免两条链路出现行为漂移。直接原地修改传入的 tracks / overlays 数组。
 */
function applyAICardDraftToTimeline(
  state: Pick<TimelineStore, 'timeline'>,
  tracks: TimelineTrack[],
  overlays: OverlayItem[],
  card: AICardTimelineDraft,
): void {
  const existingAITrack = tracks.find((track) => track.id === DEFAULT_AI_CARDS_TRACK_ID);
  const trackId = existingAITrack?.id ?? DEFAULT_AI_CARDS_TRACK_ID;
  if (!existingAITrack) {
    tracks.push(createVisualTrack(2, 2));
  }

  const nextDefaultPosition = getAICardOverlayPosition(
    card.aiCardData.displayMode,
    state.timeline.width,
    state.timeline.height,
  );

  const existingOverlayIndex = overlays.findIndex(
    (overlay) =>
      overlay.overlayType === 'ai-card' &&
      overlay.aiCardData?.sourceCardId === card.sourceCardId,
  );

  if (existingOverlayIndex >= 0) {
    const existingOverlay = overlays[existingOverlayIndex];
    const shouldResetPosition =
      existingOverlay.aiCardData?.displayMode !== card.aiCardData.displayMode ||
      (card.aiCardData.displayMode === 'pip' &&
        isFullscreenAICardPosition(
          existingOverlay.position,
          state.timeline.width,
          state.timeline.height,
        ));
    overlays[existingOverlayIndex] = {
      ...existingOverlay,
      type: 'image',
      assetPath: '',
      startMs: card.startMs,
      durationMs: card.durationMs,
      position: shouldResetPosition ? nextDefaultPosition : existingOverlay.position,
      overlayType: 'ai-card',
      aiCardData: {
        ...card.aiCardData,
        sourceCardId: card.sourceCardId,
      },
    };
    return;
  }

  overlays.push({
    id: `${card.sourceCardId}-${uuid()}`,
    type: 'image',
    assetPath: '',
    trackId,
    startMs: card.startMs,
    durationMs: card.durationMs,
    position: nextDefaultPosition,
    overlayType: 'ai-card',
    aiCardData: {
      ...card.aiCardData,
      sourceCardId: card.sourceCardId,
    },
  });
}

function emitSaveStatus(status: SaveStatus): void {
  currentSaveStatus = status;
  for (const listener of saveStatusListeners) {
    listener(status);
  }
}

function getStorageItem(key: string): string {
  if (!hasBrowserStorage()) {
    return '';
  }

  return window.localStorage.getItem(key) || '';
}

function setStorageItem(key: string, value: string): void {
  if (!hasBrowserStorage()) {
    return;
  }

  window.localStorage.setItem(key, value);
}

function removeStorageItem(key: string): void {
  if (!hasBrowserStorage()) {
    return;
  }

  window.localStorage.removeItem(key);
}

export function getCurrentSaveStatus(): SaveStatus {
  return currentSaveStatus;
}

export function subscribeToSaveStatus(listener: (status: SaveStatus) => void): () => void {
  saveStatusListeners.add(listener);
  listener(currentSaveStatus);
  return () => {
    saveStatusListeners.delete(listener);
  };
}

// 反射外部文件变更（project.json 被外部/AI 改动后重载）期间置位。
// autosave 订阅据此跳过这一次写回——纯 disk→memory 的镜像不应再产生 memory→disk 写，
// 否则 chokidar 会把回写当成新的外部编辑，形成 watch ⇄ autosave 死循环（UI 卡在"保存中…"）。
let reflectingExternalChange = false;

/** 在反射外部变更期间执行 fn，使其引发的 store 变更不触发 autosave。 */
function withExternalReflection(fn: () => void): void {
  reflectingExternalChange = true;
  try {
    fn();
  } finally {
    reflectingExternalChange = false;
  }
}

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  timeline: createDefaultTimeline(),
  srtEntries: [],
  originalSrtEntries: [],
  podcastRevision: 0,
  assets: [],
  overlayClipboard: null,
  canUndo: false,
  canRedo: false,
  historyPast: [],
  historyFuture: [],
  subtitleSelection: [],
  setSubtitleSelection: (indices) => {
    const deduped = Array.from(new Set(indices.filter((i) => Number.isFinite(i)))).sort(
      (a, b) => a - b,
    );
    const current = get().subtitleSelection;
    if (
      current.length === deduped.length &&
      current.every((value, idx) => value === deduped[idx])
    ) {
      return;
    }
    set({ subtitleSelection: deduped });
  },
  clearSubtitleSelection: () => {
    if (get().subtitleSelection.length === 0) {
      return;
    }
    set({ subtitleSelection: [] });
  },
  setTimeline: (timeline) =>
    set((state) => {
      const normalizedTimeline = normalizeTimeline(timeline);

      return {
        timeline: normalizedTimeline,
        podcastRevision: state.podcastRevision + 1,
        assets: syncAssetsWithTimeline([], normalizedTimeline),
        overlayClipboard: null,
        historyPast: [],
        historyFuture: [],
        canUndo: false,
        canRedo: false,
        subtitleSelection: [],
      };
    }),
  applyExternalTimeline: (timeline) =>
    withExternalReflection(() =>
      set((state) => {
        const normalizedTimeline = normalizeTimeline(timeline);
        return {
          timeline: normalizedTimeline,
          podcastRevision: state.podcastRevision + 1,
          assets: syncAssetsWithTimeline([], normalizedTimeline),
        };
      }),
    ),
  applyExternalCardSource: (overlayId, tsx) =>
    withExternalReflection(() =>
      set((state) => {
        if (!state.timeline) return state;
        const overlays = state.timeline.overlays.map((ov) =>
          ov.id === overlayId && ov.aiCardData?.motionCard
            ? {
                ...ov,
                aiCardData: {
                  ...ov.aiCardData,
                  motionCard: { ...ov.aiCardData.motionCard, tsx, compileError: undefined },
                },
              }
            : ov,
        );
        return { timeline: { ...state.timeline, overlays } };
      }),
    ),
  setSrtEntries: (entries) =>
    set((state) => {
      const maxChars = state.timeline.subtitle.maxCharsPerEntry;
      const autoResegment = state.timeline.subtitle.autoResegment;
      const needSplit = autoResegment && entries.some((e) => e.text.length > maxChars);
      const nextSrtEntries = needSplit ? resegmentSrtEntries(entries, maxChars) : entries;

      let nextHighlights = state.timeline.subtitleHighlights ?? [];
      if (needSplit && nextHighlights.length > 0) {
        const { remapped } = remapHighlightsAfterResegment(nextHighlights, nextSrtEntries);
        nextHighlights = remapped;
      }

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        subtitleHighlights: nextHighlights,
      });

      return {
        originalSrtEntries: entries,
        srtEntries: nextSrtEntries,
        timeline: nextTimeline,
        subtitleSelection: [],
      };
    }),
  setSubtitleHighlights: (highlights) =>
    set((state) => {
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        subtitleHighlights: [...highlights],
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  clearSubtitleHighlights: () =>
    set((state) => {
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        subtitleHighlights: [],
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  updateSubtitleStyle: (updates) =>
    set((state) => {
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        subtitle: {
          ...state.timeline.subtitle,
          ...updates,
        },
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  setSubtitleMaxChars: (n) => {
    get().updateSubtitleStyle({ maxCharsPerEntry: n });
    if (get().timeline.subtitle.autoResegment) {
      get().resegmentSubtitles();
    }
  },
  resegmentSubtitles: () => {
    const state = get();
    const baseline = state.originalSrtEntries;
    const maxChars = state.timeline.subtitle.maxCharsPerEntry;
    const nextEntries = resegmentSrtEntries(baseline, maxChars);
    const { remapped, dropped } = remapHighlightsAfterResegment(
      state.timeline.subtitleHighlights ?? [],
      nextEntries,
    );
    set((prev) => {
      const nextTimeline = normalizeTimeline({
        ...prev.timeline,
        subtitleHighlights: remapped,
      });
      // 注意：buildCommittedTimelineState 仅快照 timeline，不包含 srtEntries。
      // 因此 undo 可还原 subtitleHighlights，但 srtEntries 不会随之还原（已知限制）。
      return {
        ...buildCommittedTimelineState(prev, nextTimeline),
        srtEntries: nextEntries,
      };
    });
    return { droppedHighlights: dropped.length };
  },
  restoreOriginalSubtitles: () => {
    const state = get();
    const baseline = state.originalSrtEntries;
    if (baseline.length === 0) {
      return;
    }
    const { remapped } = remapHighlightsAfterResegment(
      state.timeline.subtitleHighlights ?? [],
      baseline,
    );
    set((prev) => {
      const nextTimeline = normalizeTimeline({
        ...prev.timeline,
        subtitleHighlights: remapped,
      });
      // 注意：与 resegmentSubtitles 相同，srtEntries 不在 undo/redo 快照范围内（已知限制）。
      return {
        ...buildCommittedTimelineState(prev, nextTimeline),
        srtEntries: baseline,
      };
    });
  },
  setAutoResegment: (enabled) => {
    get().updateSubtitleStyle({ autoResegment: enabled });
  },
  setPodcast: (audioPath, srtPath, durationMs) =>
    set((state) => {
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        podcast: {
          audioPath,
          srtPath,
          durationMs,
        },
      });

      return {
        ...buildCommittedTimelineState(state, nextTimeline),
        podcastRevision: state.podcastRevision + 1,
      };
    }),
  setGlobalBackground: (path) =>
    set((state) => {
      const existingOverlay = state.timeline.overlays.find(
        (overlay) => overlay.overlayRole === 'default-background',
      );
      const backgroundOverlay: OverlayItem = {
        id: existingOverlay?.id ?? `background-${uuid()}`,
        type: 'image',
        assetPath: path,
        trackId: existingOverlay?.trackId ?? DEFAULT_VISUAL_TRACK_ID,
        startMs: 0,
        durationMs: getDefaultBackgroundDuration(state.timeline),
        position: {
          x: 0,
          y: 0,
          width: state.timeline.width,
          height: state.timeline.height,
        },
        overlayRole: 'default-background',
      };
      const overlays = existingOverlay
        ? state.timeline.overlays.map((overlay) =>
            overlay.overlayRole === 'default-background' ? backgroundOverlay : overlay,
          )
        : [backgroundOverlay, ...state.timeline.overlays];
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays,
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  addAsset: (path, type, durationMs) =>
    set((state) => ({
      assets: dedupeAssets([...state.assets, buildAsset(path, type, durationMs)]),
    })),
  addAssets: (items) =>
    set((state) => ({
      assets: dedupeAssets([
        ...state.assets,
        ...items.map((i) => buildAsset(i.path, i.type, i.durationMs)),
      ]),
    })),
  removeAsset: (path) =>
    set((state) => {
      const targetAsset = state.assets.find((asset) => asset.path === path);
      if (!targetAsset || targetAsset.locked) {
        return {};
      }

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.filter((overlay) => overlay.assetPath !== path),
      });

      return buildCommittedTimelineState(state, nextTimeline, {
        assetSource: state.assets.filter((asset) => asset.path !== path),
      });
    }),
  addTrack: () => {
    const track = getNextVisualTrack(useTimelineStore.getState().timeline.tracks);

    set((state) => {
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks: [...state.timeline.tracks, track],
      });

      return buildCommittedTimelineState(state, nextTimeline);
    });

    return track.id;
  },
  createTrackAt: (position) => {
    const state = useTimelineStore.getState();
    const tracks = state.timeline.tracks;

    // 升序(order 小的在前)用于 gap 索引计算,保持既有 'top'=lowest/'bottom'=highest 语义
    const ascOrderedVisualTracks = [...tracks.filter((t) => t.kind === 'visual')]
      .sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }
        return left.id.localeCompare(right.id);
      });
    const visualCount = ascOrderedVisualTracks.length;

    // 将 'top'/'bottom' 翻译为 gap 索引,保持既有测试/行为
    let gapIndex: number;
    if (position === 'top') {
      gapIndex = 0;
    } else if (position === 'bottom') {
      gapIndex = visualCount;
    } else {
      gapIndex = Math.max(0, Math.min(visualCount, position.gapIndex));
    }

    // 生成新 id
    const existingIds = new Set(ascOrderedVisualTracks.map((t) => t.id));
    let nextIndex = 1;
    while (existingIds.has(`visual-${nextIndex}`)) nextIndex += 1;

    const newTrack: TimelineTrack = {
      id: `visual-${nextIndex}`,
      kind: 'visual',
      label: `轨道 ${nextIndex}`,
      order: 0,
    };

    // 按 gapIndex 插入 asc 顺序数组
    const insertedAsc = [
      ...ascOrderedVisualTracks.slice(0, gapIndex),
      newTrack,
      ...ascOrderedVisualTracks.slice(gapIndex),
    ];

    // 重新编号 order 为连续的 0..N-1
    const reorderedMap = new Map<string, number>();
    insertedAsc.forEach((track, index) => {
      reorderedMap.set(track.id, index);
    });

    set((currentState) => {
      const existingTrackMap = new Map(
        currentState.timeline.tracks
          .filter((t) => t.kind === 'visual')
          .map((t) => [t.id, t] as const),
      );
      const mergedVisualTracks = insertedAsc.map((track) => {
        const existing = existingTrackMap.get(track.id);
        return {
          ...(existing ?? track),
          order: reorderedMap.get(track.id) ?? 0,
        };
      });
      const nonVisualTracks = currentState.timeline.tracks.filter(
        (t) => t.kind !== 'visual',
      );
      const nextTimeline = normalizeTimeline({
        ...currentState.timeline,
        tracks: [...nonVisualTracks, ...mergedVisualTracks],
      });
      return buildCommittedTimelineState(currentState, nextTimeline);
    });

    return newTrack.id;
  },
  toggleTrackLocked: (trackId) =>
    set((state) => {
      const track = state.timeline.tracks.find((t) => t.id === trackId);
      if (!track) return {};
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks: state.timeline.tracks.map((t) =>
          t.id === trackId ? { ...t, locked: !t.locked } : t,
        ),
      });
      return buildCommittedTimelineState(state, nextTimeline);
    }),
  removeTrack: (id) =>
    set((state) => {
      const target = state.timeline.tracks.find((track) => track.id === id);
      if (!target || target.locked) {
        return {};
      }

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks: state.timeline.tracks.filter((track) => track.id !== id),
        overlays: state.timeline.overlays.filter((overlay) => overlay.trackId !== id),
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  addOverlay: (overlay) => {
    const id = uuid();
    set((state) => {
      const { overlay: resolved, createdTrack } = resolveOverlayInsert(
        state,
        { ...overlay, id },
      );
      const tracks = createdTrack
        ? [...state.timeline.tracks, createdTrack]
        : state.timeline.tracks;
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks,
        overlays: [...state.timeline.overlays, resolved],
      });

      return buildCommittedTimelineState(state, nextTimeline);
    });

    return id;
  },
  addAICardsToTimeline: (cards) =>
    set((state) => {
      const tracks = [...state.timeline.tracks];
      const overlays = [...state.timeline.overlays];

      for (const card of cards) {
        applyAICardDraftToTimeline(state, tracks, overlays, card);
      }
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks,
        overlays,
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  replaceAICardsOnTimeline: (cards, sourceCardIds, options) => {
    const replace = () => set((state) => {
      const sourceIds = new Set(sourceCardIds);
      const nextSourceIds = new Set(cards.map((card) => card.sourceCardId));
      const tracks = [...state.timeline.tracks];
      let overlays = state.timeline.overlays.filter((overlay) => (
        overlay.overlayType !== 'ai-card'
        || !overlay.aiCardData?.sourceCardId
        || !sourceIds.has(overlay.aiCardData.sourceCardId)
        || nextSourceIds.has(overlay.aiCardData.sourceCardId)
      ));
      for (const card of cards) {
        applyAICardDraftToTimeline(state, tracks, overlays, card);
      }
      if (options?.footageOverlays) {
        // footage 素材 overlay 与卡片同批原子替换：先移除全部旧 footage
        // （footageData 标记），再按 startMs 并入新批次；visual-2 缺失时补建。
        if (
          options.footageOverlays.length > 0
          && !tracks.some((track) => track.id === DEFAULT_AI_CARDS_TRACK_ID)
        ) {
          tracks.push(createVisualTrack(2, 2));
        }
        overlays = overlays.filter((overlay) => !overlay.footageData);
        overlays.push(
          ...[...options.footageOverlays].sort((left, right) => left.startMs - right.startMs),
        );
      }
      const nextTimeline = normalizeTimeline({ ...state.timeline, tracks, overlays });
      return buildCommittedTimelineState(state, nextTimeline);
    });
    if (options?.skipAutosave) {
      withExternalReflection(replace);
      return;
    }
    replace();
  },
  appendAICardToTimeline: (card, options) =>
    set((state) => {
      const tracks = [...state.timeline.tracks];
      const overlays = [...state.timeline.overlays];

      applyAICardDraftToTimeline(state, tracks, overlays, card);

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks,
        overlays,
      });

      // 历史合并：一次分析运行里连续的增量 append 不应在 undo 栈塞入几十条记录。
      // 第一张（运行内首次 coalesce）正常推入一次历史快照，建立单一撤销点；
      // 后续张保留 historyPast 原样（不再叠加），从而整轮折叠成一条撤销记录。
      // 无论是否合并，timeline 都即时更新，每张卡片都立即可见。
      if (options?.coalesceHistory) {
        const isContinuation = lastCommitWasCoalescedAICardAppend;
        lastCommitWasCoalescedAICardAppend = true;

        if (isContinuation) {
          return {
            historyPast: state.historyPast,
            historyFuture: [],
            canUndo: state.historyPast.length > 0,
            canRedo: false,
            timeline: nextTimeline,
            assets: syncAssetsWithTimeline(state.assets, nextTimeline),
          };
        }

        // 运行内首张：复用标准提交（会推入历史快照），但 buildCommittedTimelineState
        // 会把标记清零，这里重新置位以衔接后续张。
        const committed = buildCommittedTimelineState(state, nextTimeline);
        lastCommitWasCoalescedAICardAppend = true;
        return committed;
      }

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  removeAICardOverlaysBySourceIds: (sourceCardIds) =>
    set((state) => {
      if (sourceCardIds.length === 0) {
        return {};
      }

      const sourceCardIdSet = new Set(sourceCardIds);
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.filter(
          (overlay) =>
            overlay.overlayType !== 'ai-card' ||
            !overlay.aiCardData?.sourceCardId ||
            !sourceCardIdSet.has(overlay.aiCardData.sourceCardId),
        ),
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  copyOverlay: (id) => {
    let copied = false;

    set((state) => {
      const current = state.timeline.overlays.find((overlay) => overlay.id === id);
      if (!current || current.overlayRole === 'default-background') {
        return {};
      }

      copied = true;
      return {
        overlayClipboard: {
          ...buildOverlayClipboardItem(current),
          mode: 'copy',
        },
      };
    });

    return copied;
  },
  cutOverlay: (id) => {
    let cut = false;

    set((state) => {
      const current = state.timeline.overlays.find((overlay) => overlay.id === id);
      if (!current || current.overlayRole === 'default-background') {
        return {};
      }

      cut = true;
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.filter((overlay) => overlay.id !== id),
      });

      return buildCommittedTimelineState(state, nextTimeline, {
        overlayClipboard: {
          ...buildOverlayClipboardItem(current),
          mode: 'cut',
        },
      });
    });

    return cut;
  },
  pasteOverlay: ({ trackId, startMs }) => {
    let pastedOverlayId: string | null = null;

    set((state) => {
      if (!state.overlayClipboard) {
        return {};
      }

      const { mode, ...clipboardDraft } = state.overlayClipboard;
      const draft: OverlayItem = {
        ...cloneOverlayDraft(clipboardDraft),
        id: uuid(),
        trackId,
        startMs,
      };
      const { overlay: resolved, createdTrack } = resolveOverlayInsert(state, draft);
      pastedOverlayId = resolved.id;
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        tracks: createdTrack ? [...state.timeline.tracks, createdTrack] : state.timeline.tracks,
        overlays: [...state.timeline.overlays, resolved],
      });

      return buildCommittedTimelineState(state, nextTimeline, {
        overlayClipboard: mode === 'copy' ? state.overlayClipboard : null,
      });
    });

    return pastedOverlayId;
  },
  updateOverlay: (id, updates) =>
    set((state) => {
      const current = state.timeline.overlays.find((o) => o.id === id);
      if (!current) {
        return {};
      }

      // 锁检查：来源或目标轨道锁定时，整个 update 跳过
      const sourceTrack = state.timeline.tracks.find((t) => t.id === current.trackId);
      if (sourceTrack?.locked) {
        return {};
      }
      const targetTrackId = (updates.trackId ?? current.trackId) as string;
      const targetTrack = state.timeline.tracks.find((t) => t.id === targetTrackId);
      if (targetTrack?.locked) {
        return {};
      }

      let merged = { ...current, ...updates, id };
      const affectsPlacement =
        'startMs' in updates || 'durationMs' in updates || 'trackId' in updates;

      if (affectsPlacement && isOverlayTrackManaged(merged)) {
        // 时长变化仍允许邻居 clamp（避免拉伸覆盖右邻）
        if ('durationMs' in updates) {
          merged = {
            ...merged,
            durationMs: clampOverlayDurationByNeighbors({
              overlayId: id,
              startMs: merged.startMs,
              requestedDurationMs: merged.durationMs,
              trackId: merged.trackId,
              overlays: state.timeline.overlays,
            }),
          };
        }

        // 位置 / 跨轨变化：使用 canPlaceAt，碰撞则拒绝
        const placement = canPlaceAt({
          trackId: merged.trackId,
          startMs: merged.startMs,
          durationMs: merged.durationMs,
          excludeOverlayId: id,
          overlays: state.timeline.overlays,
        });

        if (!placement.ok) {
          // 放弃本次位置更新，保留原始位置和轨道
          merged = {
            ...merged,
            startMs: current.startMs,
            trackId: current.trackId,
          };
        }
      }

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.map((o) =>
          o.id === id ? merged : o,
        ),
      });
      return buildCommittedTimelineState(state, nextTimeline);
    }),
  trimOverlayClip: (id, edge, newEdgeMs) =>
    set((state) => {
      const current = state.timeline.overlays.find((o) => o.id === id);
      if (!current) return {};

      const track = state.timeline.tracks.find((t) => t.id === current.trackId);
      if (track?.locked) return {};

      const MIN_DURATION = 100;
      let nextStart = current.startMs;
      let nextDuration = current.durationMs;

      if (edge === 'start') {
        const currentEnd = current.startMs + current.durationMs;
        // 钳制到 [0, currentEnd - MIN_DURATION]
        const clamped = Math.max(0, Math.min(newEdgeMs, currentEnd - MIN_DURATION));
        nextStart = clamped;
        nextDuration = currentEnd - clamped;
      } else {
        // end edge
        const minEnd = current.startMs + MIN_DURATION;
        const clampedEnd = Math.max(minEnd, newEdgeMs);
        nextStart = current.startMs;
        nextDuration = clampedEnd - current.startMs;
      }

      // 碰撞约束：使用 clampOverlayDurationByNeighbors 做右侧 clamp
      if (edge === 'end' && isOverlayTrackManaged(current)) {
        nextDuration = clampOverlayDurationByNeighbors({
          overlayId: id,
          startMs: nextStart,
          requestedDurationMs: nextDuration,
          trackId: current.trackId,
          overlays: state.timeline.overlays,
        });
        nextDuration = Math.max(MIN_DURATION, nextDuration);
      }

      // 左 trim 的碰撞约束：不得越过左邻 clip 的 end
      if (edge === 'start' && isOverlayTrackManaged(current)) {
        const leftNeighborEnd = state.timeline.overlays
          .filter(
            (o) =>
              o.trackId === current.trackId
              && o.id !== id
              && isOverlayTrackManaged(o)
              && o.startMs + o.durationMs <= current.startMs,
          )
          .reduce((max, o) => Math.max(max, o.startMs + o.durationMs), 0);
        if (nextStart < leftNeighborEnd) {
          const delta = leftNeighborEnd - nextStart;
          nextStart = leftNeighborEnd;
          nextDuration = Math.max(MIN_DURATION, nextDuration - delta);
        }
      }

      const nextOverlay: OverlayItem = {
        ...current,
        startMs: nextStart,
        durationMs: nextDuration,
      };

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.map((o) =>
          o.id === id ? nextOverlay : o,
        ),
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  splitOverlayClipsAt: (playheadMs, targetIds) =>
    set((state) => {
      const EDGE_TOLERANCE = 50;

      const eligibleIds = new Set(
        targetIds ?? state.timeline.overlays.map((o) => o.id),
      );
      const newOverlays: OverlayItem[] = [];
      let didSplit = false;

      for (const overlay of state.timeline.overlays) {
        if (!eligibleIds.has(overlay.id)) {
          newOverlays.push(overlay);
          continue;
        }

        const track = state.timeline.tracks.find((t) => t.id === overlay.trackId);
        if (track?.locked) {
          newOverlays.push(overlay);
          continue;
        }

        const leftDuration = playheadMs - overlay.startMs;
        const rightDuration = overlay.durationMs - leftDuration;

        if (leftDuration < EDGE_TOLERANCE || rightDuration < EDGE_TOLERANCE) {
          newOverlays.push(overlay);
          continue;
        }

        didSplit = true;
        const leftClip: OverlayItem = {
          ...overlay,
          durationMs: leftDuration,
        };
        const rightClip: OverlayItem = {
          ...overlay,
          id: uuid(),
          startMs: playheadMs,
          durationMs: rightDuration,
        };
        newOverlays.push(leftClip, rightClip);
      }

      if (!didSplit) {
        return {};
      }

      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: newOverlays,
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  removeOverlay: (id) =>
    set((state) => {
      const target = state.timeline.overlays.find((o) => o.id === id);
      if (target) {
        const track = state.timeline.tracks.find((t) => t.id === target.trackId);
        if (track?.locked) return {};
      }
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.filter((overlay) => overlay.id !== id),
      });

      return buildCommittedTimelineState(state, nextTimeline);
    }),
  removeOverlaysByIds: (ids, options) =>
    set((state) => {
      if (ids.length === 0) return {};
      const requested = new Set(ids);
      const removable = options?.ignoreTrackLock
        ? requested
        : new Set(state.timeline.overlays
            .filter((overlay) => requested.has(overlay.id))
            .filter((overlay) => !state.timeline.tracks.find((track) => track.id === overlay.trackId)?.locked)
            .map((overlay) => overlay.id));
      if (removable.size === 0) return {};
      const nextTimeline = normalizeTimeline({
        ...state.timeline,
        overlays: state.timeline.overlays.filter((overlay) => !removable.has(overlay.id)),
      });
      return buildCommittedTimelineState(state, nextTimeline);
    }),
  undo: () =>
    set((state) => {
      if (state.historyPast.length === 0) {
        return {};
      }

      const previousTimeline = state.historyPast[state.historyPast.length - 1];
      const nextPast = state.historyPast.slice(0, -1);
      const nextFuture = [cloneTimeline(state.timeline), ...state.historyFuture].slice(
        0,
        MAX_TIMELINE_HISTORY,
      );
      const normalizedTimeline = normalizeTimeline(previousTimeline);

      return {
        timeline: normalizedTimeline,
        assets: syncAssetsWithTimeline(state.assets, normalizedTimeline),
        historyPast: nextPast,
        historyFuture: nextFuture,
        canUndo: nextPast.length > 0,
        canRedo: nextFuture.length > 0,
      };
    }),
  redo: () =>
    set((state) => {
      if (state.historyFuture.length === 0) {
        return {};
      }

      const [nextTimeline, ...remainingFuture] = state.historyFuture;
      const nextPast = pushHistorySnapshot(state.historyPast, state.timeline);
      const normalizedTimeline = normalizeTimeline(nextTimeline);

      return {
        timeline: normalizedTimeline,
        assets: syncAssetsWithTimeline(state.assets, normalizedTimeline),
        historyPast: nextPast,
        historyFuture: remainingFuture,
        canUndo: nextPast.length > 0,
        canRedo: remainingFuture.length > 0,
      };
    }),
}));

function hasBrowserStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getCurrentProjectDir(): string {
  return getStorageItem(PROJECT_DIR_KEY);
}

export function getProjectDir(): string {
  return getCurrentProjectDir();
}

export function setCurrentProjectDir(projectDir: string): void {
  setStorageItem(PROJECT_DIR_KEY, projectDir);
}

export function setProjectDir(projectDir: string): void {
  setCurrentProjectDir(projectDir);
}

export function clearCurrentProject(): void {
  removeStorageItem(PROJECT_DIR_KEY);
  emitSaveStatus('idle');
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

if (typeof window !== 'undefined') {
  useTimelineStore.subscribe((state, previousState) => {
    if (state.timeline === previousState.timeline) {
      return;
    }

    // 反射外部变更（applyExternalTimeline / applyExternalCardSource）期间不回写，
    // 否则会把刚从磁盘读入的内容又写回磁盘，触发 watch ⇄ autosave 死循环。
    if (reflectingExternalChange) {
      return;
    }

    // AI 文件编辑会话锁定期间，暂停自动保存，避免与外部文件写入互相覆盖。
    if (isAiEditLocked()) {
      return;
    }

    const projectDir = getProjectDir();
    if (!projectDir || !window.electronAPI?.saveProjectSection) {
      return;
    }

    emitSaveStatus('saving');
    const productionGuard = getProductionSaveGuard();
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(() => {
      const saveRequest = productionGuard
        ? window.electronAPI.saveProjectSection(
            projectDir,
            'timeline',
            JSON.stringify(state.timeline),
            productionGuard,
          )
        : window.electronAPI.saveProjectSection(
            projectDir,
            'timeline',
            JSON.stringify(state.timeline),
          );
      void saveRequest
        .then(() => {
          emitSaveStatus('saved');
        })
        .catch((error) => {
          console.error('保存 timeline 失败:', error);
          emitSaveStatus('error');
        });
    }, 300);
  });
}
