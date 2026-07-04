import type {
  TextEnterAnimation,
  TextExitAnimation,
  TextLoopAnimation,
} from '../types';

export interface MotionPreset<T extends string> {
  value: T;
  label: string;
}

// 文字与媒体 overlay 共用同一套进出场/循环动画模型（见 src/types.ts OverlayMotion），
// 预设与中文标签在此单点维护，TextInspector / OverlayInspector 共同消费。

export const ENTER_PRESETS: MotionPreset<TextEnterAnimation>[] = [
  { value: 'none', label: '无' },
  { value: 'fadeIn', label: '淡入' },
  { value: 'slideInLeft', label: '左滑入' },
  { value: 'slideInRight', label: '右滑入' },
  { value: 'slideInUp', label: '上滑入' },
  { value: 'slideInDown', label: '下滑入' },
  { value: 'scaleIn', label: '缩放入' },
  { value: 'bounceIn', label: '弹入' },
];

export const LOOP_PRESETS: MotionPreset<TextLoopAnimation>[] = [
  { value: 'none', label: '无' },
  { value: 'pulse', label: '呼吸' },
  { value: 'float', label: '浮动' },
  { value: 'flicker', label: '闪烁' },
  { value: 'typewriter', label: '打字机' },
];

export const EXIT_PRESETS: MotionPreset<TextExitAnimation>[] = [
  { value: 'none', label: '无' },
  { value: 'fadeOut', label: '淡出' },
  { value: 'slideOutLeft', label: '左滑出' },
  { value: 'slideOutRight', label: '右滑出' },
  { value: 'slideOutUp', label: '上滑出' },
  { value: 'slideOutDown', label: '下滑出' },
  { value: 'scaleOut', label: '缩放出' },
  { value: 'bounceOut', label: '弹出' },
];
