import { describe, expect, it } from 'vitest';
import { computeDropdownPosition } from '../src/ui/components/dropdown-menu';

const viewport = { width: 1200, height: 800 };
const menu = { width: 320, height: 280 };

describe('computeDropdownPosition', () => {
  it('end 对齐贴在触发按钮右侧，不向窗口外延伸', () => {
    const trigger = { top: 16, left: 860, right: 1176, bottom: 48, width: 316 };
    const pos = computeDropdownPosition({
      trigger,
      menu,
      viewport,
      align: 'end',
      side: 'bottom',
      sideOffset: 6,
    });
    expect(pos.left).toBe(trigger.right - menu.width);
    expect(pos.left + menu.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(pos.left).toBeGreaterThanOrEqual(12);
    expect(pos.transformOrigin).toBe('top right');
  });

  it('贴右边时把菜单整体左移，避免越过窗口', () => {
    const trigger = { top: 16, left: 1000, right: 1188, bottom: 48, width: 188 };
    const pos = computeDropdownPosition({
      trigger,
      menu: { width: 360, height: 240 },
      viewport,
      align: 'end',
      side: 'bottom',
      sideOffset: 6,
    });
    expect(pos.left + 360).toBeLessThanOrEqual(viewport.width - 12);
    expect(pos.left).not.toBe(trigger.right);
  });

  it('start 对齐贴触发按钮左侧', () => {
    const trigger = { top: 80, left: 24, right: 160, bottom: 112, width: 136 };
    const pos = computeDropdownPosition({
      trigger,
      menu,
      viewport,
      align: 'start',
      side: 'bottom',
      sideOffset: 6,
    });
    expect(pos.left).toBe(24);
    expect(pos.transformOrigin).toBe('top left');
  });
});
