import type { CSSProperties } from 'react';
import type { CardAssetBinding } from '../types/assets';
import type { TimingPlan } from '../types/motion';

export interface MotionAssetRenderContext {
  width: number;
  height: number;
  durationInFrames: number;
  timingPlan?: TimingPlan;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function revealFrame(binding: CardAssetBinding, timingPlan?: TimingPlan): number {
  const revealBeat = binding.motion?.revealBeat ?? binding.request?.revealBeat;
  if (revealBeat == null) return 0;
  return timingPlan?.beats.find((beat) => beat.storyboardBeatIndex === revealBeat)?.startFrame ?? 0;
}

function treatmentFilter(binding: CardAssetBinding): string {
  const profile = binding.treatment.profile;
  if (profile === 'documentary-desk') return 'saturate(0.72) sepia(0.12) contrast(0.98)';
  if (profile === 'technical-product') return 'saturate(0.9) contrast(1.06) brightness(1.02)';
  if (profile === 'paper-archive') return 'saturate(0.65) sepia(0.18) contrast(0.94)';
  if (profile === 'diagram-prop') return 'saturate(0.88) contrast(1.03)';
  return 'saturate(0.82) contrast(0.98)';
}

function treatmentShadow(binding: CardAssetBinding): string {
  if (binding.placement.depth === 'background') return '';
  if (binding.treatment.profile === 'diagram-prop') return 'drop-shadow(0 8px 14px rgba(0,0,0,0.22))';
  if (binding.treatment.shadow === 'none') return '';
  return 'drop-shadow(0 14px 24px rgba(0,0,0,0.34))';
}

export function isMotionAssetUnderlay(binding: CardAssetBinding): boolean {
  return binding.placement.depth !== 'foreground';
}

export function motionAssetStyle(
  binding: CardAssetBinding,
  frame: number,
  context: MotionAssetRenderContext,
): CSSProperties {
  const { placement } = binding;
  const scaleX = context.width / (placement.referenceWidth || context.width);
  const scaleY = context.height / (placement.referenceHeight || context.height);
  const startFrame = revealFrame(binding, context.timingPlan);
  const localFrame = frame - startFrame;
  const enterFrames = Math.max(1, Math.round((context.timingPlan?.fps ?? 30) * 0.6));
  const progress = clamp01(localFrame / enterFrames);
  const eased = 1 - Math.pow(1 - progress, 3);
  const enter = binding.motion?.enter ?? 'fade-up-soft';
  const translateY = enter === 'fade-up-soft' ? (1 - eased) * 20 * scaleY : 0;
  const translateX = enter === 'slide-left' ? (1 - eased) * 26 * scaleX : 0;
  const parallax = binding.motion?.emphasis === 'subtle-parallax' && localFrame >= 0
    ? Math.sin(localFrame / 55) * 4 * scaleX
    : 0;
  const exitFrames = Math.max(1, Math.round((context.timingPlan?.fps ?? 30) * 0.5));
  const exitStart = Math.max(startFrame, context.durationInFrames - exitFrames);
  const exitOpacity = binding.motion?.exit === 'fade-out'
    ? 1 - clamp01((frame - exitStart) / exitFrames)
    : 1;
  const baseOpacity = placement.opacity ?? 1;
  const enterOpacity = enter === 'hold' ? (localFrame >= 0 ? 1 : 0) : eased;
  const role = binding.request?.role;

  return {
    position: 'absolute',
    left: placement.x * scaleX,
    top: placement.y * scaleY,
    width: placement.width * scaleX,
    height: placement.height ? placement.height * scaleY : undefined,
    opacity: baseOpacity * enterOpacity * exitOpacity,
    transform: [
      `translate3d(${translateX + parallax}px, ${translateY}px, 0)`,
      `rotate(${placement.rotation ?? 0}deg)`,
    ].join(' '),
    filter: [treatmentFilter(binding), treatmentShadow(binding)].filter(Boolean).join(' '),
    objectFit: role === 'background' || role === 'texture' ? 'cover' : 'contain',
    mixBlendMode: role === 'texture' ? 'multiply' : 'normal',
    pointerEvents: 'none',
    zIndex: isMotionAssetUnderlay(binding) ? 0 : 2,
  };
}

export function motionAssetSignature(bindings: CardAssetBinding[]): string {
  return bindings
    .map((binding) => [
      binding.slot,
      binding.assetId,
      binding.filePath,
      binding.fileFingerprint ?? '',
      binding.metadata?.processedAt ?? '',
      binding.metadata?.processedColorKey ?? '',
    ].join(':'))
    .sort()
    .join('|');
}
