import type { AICardOverlayData } from './types/ai';
import type { MotionTimingMetadata } from './types/motion';

export interface SrtEntry {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface OverlayPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayRole = 'default-background';

export type TimelineTrackKind = 'audio' | 'subtitle' | 'visual';

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  label: string;
  order: number;
  locked?: boolean;
}

export interface AudioOverlayData {
  /** 制作计划中的声音 cue ID；用于素材替换时精确定位，避免按时间猜测。 */
  cueId?: string;
  /** 线性音量 0..1.5，1 表示原始响度 */
  volume: number;
  /** 淡入时长（毫秒） */
  fadeInMs: number;
  /** 淡出时长（毫秒） */
  fadeOutMs: number;
  /** 源音频裁剪起点（毫秒），从源文件的该位置开始播放 */
  trimStartMs: number;
  /** 源音频总时长（毫秒），用于 UI 限制裁剪上限 */
  sourceDurationMs: number;
  /** 静音 */
  muted?: boolean;
  role?: 'dialogue' | 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound';
  loop?: boolean;
  /** 关键帧音量，atMs 相对当前 overlay 起点。 */
  volumeEnvelope?: Array<{ atMs: number; volume: number }>;
  ducking?: {
    enabled: boolean;
    reductionDb: number;
    attackMs: number;
    releaseMs: number;
    holdMs: number;
  };
}

export interface OverlayItem {
  id: string;
  type: 'video' | 'image' | 'text' | 'audio';
  assetPath: string;
  trackId: string;
  startMs: number;
  durationMs: number;
  position: OverlayPosition;
  motion?: OverlayMotion;
  overlayType?: 'media' | 'ai-card';
  overlayRole?: OverlayRole;
  aiCardData?: AICardOverlayData;
  textData?: TextOverlayData;
  audioData?: AudioOverlayData;
}

export function createDefaultAudioOverlayData(sourceDurationMs: number): AudioOverlayData {
  return {
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    trimStartMs: 0,
    sourceDurationMs: Math.max(0, Math.round(sourceDurationMs)),
    role: 'sfx',
    loop: false,
  };
}

export interface SubtitleStyle {
  fontSize: number;
  color: string;
  position: 'top' | 'bottom' | 'center';
  highlightEnabled: boolean;
  highlightBackgroundColor: string;
  highlightTextColor: string;
  highlightPaddingX: number;
  highlightPaddingY: number;
  highlightRadius: number;
  highlightAnimation: 'pop' | 'wipe' | 'none';
  /** 单条字幕最多字符数，超过则自动切分。默认 35，范围 20~60 */
  maxCharsPerEntry: number;
  /** 是否启用自动切分。默认 true */
  autoResegment: boolean;
}

export interface SubtitleHighlight {
  entryIndex: number;
  start: number;
  end: number;
  highlightText: string;
  sourceText: string;
}

// ── Text Overlay Types ──

export type TextEnterAnimation =
  | 'none' | 'fadeIn' | 'slideInLeft' | 'slideInRight'
  | 'slideInUp' | 'slideInDown' | 'scaleIn' | 'bounceIn';

export type TextExitAnimation =
  | 'none' | 'fadeOut' | 'slideOutLeft' | 'slideOutRight'
  | 'slideOutUp' | 'slideOutDown' | 'scaleOut' | 'bounceOut';

export type TextLoopAnimation =
  | 'none' | 'pulse' | 'float' | 'flicker' | 'typewriter';

export type OverlayEnterAnimation = Exclude<TextEnterAnimation, never>;
export type OverlayExitAnimation = Exclude<TextExitAnimation, never>;
export type OverlayLoopAnimation = Exclude<TextLoopAnimation, 'typewriter'>;

export interface OverlayMotion {
  enter: OverlayEnterAnimation;
  enterDurationMs: number;
  exit: OverlayExitAnimation;
  exitDurationMs: number;
  loop: OverlayLoopAnimation;
}

export interface TextAnimation {
  enter: TextEnterAnimation;
  enterDurationMs: number;
  exit: TextExitAnimation;
  exitDurationMs: number;
  loop: TextLoopAnimation;
}

export interface TextOverlayData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textAlign: 'left' | 'center' | 'right';
  backgroundColor: string;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  letterSpacing: number;
  lineHeight: number;
  opacity: number;
  rotation: number;
  animation: TextAnimation;
}

export interface TimelineData {
  version: number;
  fps: number;
  width: number;
  height: number;
  podcast: {
    audioPath: string;
    srtPath: string;
    durationMs: number;
  };
  tracks: TimelineTrack[];
  overlays: OverlayItem[];
  subtitle: SubtitleStyle;
  subtitleHighlights?: SubtitleHighlight[];

  // ── 音频/字幕二次加工（P0：可选字段，旧项目兼容）──
  audioClips?: AudioClip[];
  ttsAssets?: TTSAsset[];
  editedSubtitles?: SrtEntry[];
  motionTimingMetadata?: MotionTimingMetadata;
}

export type AssetType = 'video' | 'image' | 'audio' | 'srt' | 'text';

export interface AssetItem {
  path: string;
  type: AssetType;
  name: string;
  durationMs: number;
  locked?: boolean;
}

export const DEFAULT_TIMELINE_VERSION = 2;
export const DEFAULT_AUDIO_TRACK_ID = 'audio';
export const DEFAULT_SUBTITLE_TRACK_ID = 'subtitle';
export const DEFAULT_VISUAL_TRACK_ID = 'visual-1';
export const DEFAULT_AI_CARDS_TRACK_ID = 'visual-2';
export const DEFAULT_AUDIO_OVERLAY_TRACK_ID = 'audio-overlay-1';

export function createAudioOverlayTrack(index: number): TimelineTrack {
  return {
    id: `audio-overlay-${index}`,
    kind: 'audio',
    label: `音轨 ${index}`,
    order: index,
  };
}

export function createVisualTrack(index: number, order = index): TimelineTrack {
  return {
    id: `visual-${index}`,
    kind: 'visual',
    label: `轨道 ${index}`,
    order,
  };
}

export function createDefaultTracks(): TimelineTrack[] {
  return [
    {
      id: DEFAULT_AUDIO_TRACK_ID,
      kind: 'audio',
      label: '口播轨',
      order: 0,
      locked: true,
    },
    {
      id: DEFAULT_SUBTITLE_TRACK_ID,
      kind: 'subtitle',
      label: '字幕轨',
      order: 0,
      locked: true,
    },
    createVisualTrack(1),
  ];
}

export function createDefaultTimeline(): TimelineData {
  return {
    version: DEFAULT_TIMELINE_VERSION,
    fps: 30,
    width: 1920,
    height: 1080,
    podcast: {
      audioPath: '',
      srtPath: '',
      durationMs: 0,
    },
    tracks: createDefaultTracks(),
    overlays: [],
    subtitle: createDefaultSubtitleStyle(),
    subtitleHighlights: [],
  };
}

export function createDefaultSubtitleStyle(): SubtitleStyle {
  return {
    fontSize: 48,
    color: '#FFFFFF',
    position: 'bottom',
    highlightEnabled: false,
    highlightBackgroundColor: '#F8DC48',
    highlightTextColor: '#FFFFFF',
    highlightPaddingX: 10,
    highlightPaddingY: 4,
    highlightRadius: 12,
    highlightAnimation: 'pop',
    maxCharsPerEntry: 35,
    autoResegment: true,
  };
}

// =============================================================================
// 音频 Clip / TTS 素材 / 音色预设（audio-subtitle-tts 二次加工）
// =============================================================================

/** MiniMax TTS 返回的字级时间戳 */
export interface WordTimestamp {
  text: string;
  startMs: number;
  endMs: number;
}

/** 音色生成参数（语速 / 音量 / 音高 / 情绪） */
export interface VoiceParams {
  speed: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
}

/** 音色预设（全局跨项目复用） */
export interface VoicePreset {
  id: string;
  name: string;
  provider: 'minimax';
  voiceId: string;
  params: VoiceParams;
  voiceSource: 'system' | 'cloned';
  createdAt: number;
  updatedAt: number;
}

/** TTS 素材（持久化到 <projectDir>/tts/） */
export interface TTSAsset {
  id: string;
  filePath: string;
  text: string;
  durationMs: number;
  voicePresetId: string;
  /** 生成时的预设完整快照，防止预设被删导致失效 */
  voicePresetSnapshot: VoicePreset;
  voiceOverrides?: Partial<VoiceParams>;
  /** TTS 返回的字级时间戳（若 API 支持） */
  wordTimestamps?: WordTimestamp[];
  createdAt: number;
  voiceSource?: 'system' | 'cloned';
}

/** 音频 Clip 的来源：原始音频片段 或 TTS 素材 */
export type AudioClipSource =
  | { kind: 'origin'; startMs: number; endMs: number }
  | { kind: 'tts'; assetId: string };

/** 音频 Clip —— 虚拟合成的基本单元 */
export interface AudioClip {
  id: string;
  source: AudioClipSource;
  /** 在时间线上的起点（毫秒） */
  timelineStartMs: number;
  /** Clip 在时间线上占用的时长（毫秒） */
  durationMs: number;
  /** 初始化时关联的字幕 index 列表 */
  linkedSubtitleIndexes: number[];
  /** 静音占位（P1 功能，P0 仅预留字段） */
  muted?: boolean;
}

export function sortOverlaysByStart(overlays: OverlayItem[]): OverlayItem[] {
  return [...overlays].sort((left, right) => {
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }

    return left.id.localeCompare(right.id);
  });
}
