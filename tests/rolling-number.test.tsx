// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { RollingNumber } from '../src/components/agent/RollingNumber';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RollingNumber', () => {
  it('keeps the previous and next values in the strip when a live count changes', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => root.render(<RollingNumber value={1} prefix="+" />));
    act(() => root.render(<RollingNumber value={3} prefix="+" />));

    const rolling = container.querySelector('[aria-label="+3"]');
    const strip = rolling?.firstElementChild as HTMLElement | null;
    expect(Array.from(strip?.children ?? []).map((node) => node.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(strip?.style.transform).toBe('translateY(-200%)');

    act(() => root.unmount());
  });
});
