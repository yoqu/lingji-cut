import type { OverlayItem, OverlayMotion, TextAnimation } from '../types';

export function createDefaultOverlayMotion(): OverlayMotion {
  return {
    enter: 'none',
    enterDurationMs: 400,
    exit: 'none',
    exitDurationMs: 400,
    loop: 'none',
  };
}

function isValidTextAnimation(value: unknown): value is TextAnimation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const animation = value as Partial<TextAnimation>;
  return (
    typeof animation.enter === 'string' &&
    typeof animation.enterDurationMs === 'number' &&
    typeof animation.exit === 'string' &&
    typeof animation.exitDurationMs === 'number' &&
    typeof animation.loop === 'string'
  );
}

export function resolveOverlayMotion(overlay: OverlayItem): OverlayMotion {
  // 文字图层的动画配置由 TextInspector 直接写入 textData.animation，
  // 因此在渲染时必须以 textData.animation 为准。
  // 否则 timeline 归一化（timeline-tracks.ts）提前物化的 overlay.motion
  // 会成为陈旧副本，导致 TextInspector 修改入场/出场/循环后预览不刷新。
  if (overlay.type === 'text' && isValidTextAnimation(overlay.textData?.animation)) {
    const { enter, enterDurationMs, exit, exitDurationMs, loop } = overlay.textData.animation;
    return {
      enter,
      enterDurationMs,
      exit,
      exitDurationMs,
      loop: loop === 'typewriter' ? 'none' : loop,
    };
  }

  if (overlay.motion) {
    return overlay.motion;
  }

  if (isValidTextAnimation(overlay.textData?.animation)) {
    const { enter, enterDurationMs, exit, exitDurationMs, loop } = overlay.textData.animation;
    return {
      enter,
      enterDurationMs,
      exit,
      exitDurationMs,
      loop: loop === 'typewriter' ? 'none' : loop,
    };
  }

  return createDefaultOverlayMotion();
}
