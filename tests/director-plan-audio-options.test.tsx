// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectorPlanEditor } from '../src/components/director/DirectorPlanEditor';
import { MotionProvider } from '../src/ui/lib/motion';
import type { DirectorPlan } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function plan(): DirectorPlan {
  return {
    revision: 1, inputFingerprint: 'audio-ui', summary: '摘要', keywords: [], segments: [],
    motionBible: {
      visualThesis: '视觉命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: {
      bgmEnabled: false, soundEffectsEnabled: false,
      bgmStyle: '克制', energy: 2, soundDensity: 'balanced',
    },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

function Harness() {
  const [value, setValue] = useState(plan);
  return (
    <MotionProvider>
      <DirectorPlanEditor
        plan={value}
        selectedSegmentId={null}
        onSelectSegment={() => undefined}
        onChange={setValue}
      />
    </MotionProvider>
  );
}

describe('director plan audio options', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hides disabled audio configuration and reveals BGM fields when enabled', () => {
    act(() => root.render(<Harness />));
    const bgm = container.querySelector<HTMLInputElement>('input[aria-label="启用背景音乐"]')!;
    const effects = container.querySelector<HTMLInputElement>('input[aria-label="启用环境与音效"]')!;
    expect(bgm.checked).toBe(false);
    expect(effects.checked).toBe(false);
    expect(container.textContent).toContain('本片只保留口播');
    expect(container.textContent).not.toContain('BGM 风格');

    act(() => bgm.click());
    expect(bgm.checked).toBe(true);
    expect(container.textContent).toContain('BGM 风格');
    expect(container.textContent).not.toContain('本片只保留口播');
  });
});
