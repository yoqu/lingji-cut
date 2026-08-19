/**
 * ken-burns —— 静态图片卡的确定性缓慢推拉（Ken Burns）。
 *
 * 纯函数：只依赖帧号与卡片时长，预览 / 导出逐帧可复现。
 * 手法与 motion-kit 摄影机 drift 一致（inOut sin 缓动的单调慢漂）。
 */
import { Easing, interpolate } from 'remotion';
import type { CSSProperties } from 'react';
import type { MotionDirectiveCameraMove } from '../types/motion';

/**
 * 按卡片时长缓慢推近（scale 1→1.07），平移方向由 seed（overlay id）奇偶交替，
 * 避免整排图片卡同向漂移。幅度克制：位移 ≤1.4%，远小于缩放富余量，永不露边。
 */
export function kenBurnsStyle(
  frame: number,
  durationFrames: number,
  seed: string,
  move?: MotionDirectiveCameraMove,
): CSSProperties {
  const p = interpolate(frame, [0, Math.max(1, durationFrames)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.sin),
  });
  const dir = [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 2 === 0 ? 1 : -1;
  if (move === 'static') return {};
  if (move === 'pull-out') {
    const scale = 1.07 - 0.07 * p;
    return { transform: `scale(${scale.toFixed(4)}) translate(0.00%, 0.00%)` };
  }
  if (move === 'pan-left' || move === 'pan-right') {
    const direction = move === 'pan-left' ? 1 : -1;
    const tx = direction * (1.4 - 2.8 * p);
    return { transform: `scale(1.0500) translate(${tx.toFixed(2)}%, 0.00%)` };
  }
  if (move === 'push-in') {
    const scale = 1 + 0.07 * p;
    return { transform: `scale(${scale.toFixed(4)}) translate(0.00%, 0.00%)` };
  }
  const scale = 1 + 0.07 * p;
  const tx = dir * 1.4 * p;
  const ty = -dir * 0.9 * p;
  return { transform: `scale(${scale.toFixed(4)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)` };
}
