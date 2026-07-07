// @vitest-environment jsdom
//
// AgentOpOverlay 测试：控制服务 op 事件 → 虚拟鼠标 + 状态标签的全局反馈层。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentOpOverlay } from '../src/components/agent/AgentOpOverlay';
import type { ControlOpEvent } from '../src/lib/electron-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emit: (ev: ControlOpEvent) => void = () => {};
const subscribe = (cb: (ev: ControlOpEvent) => void) => {
  emit = cb;
  return () => {};
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  for (const zone of ['ai-panel', 'status-bar']) {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-agent-zone', zone);
    document.body.appendChild(anchor);
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AgentOpOverlay subscribe={subscribe} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const overlay = () => container.querySelector('[data-testid="agent-op-overlay"]');
const chip = () => container.querySelector('[data-testid="agent-op-chip"]');

describe('AgentOpOverlay', () => {
  it('无事件时不渲染', () => {
    expect(overlay()).toBeNull();
  });

  it('start 事件 → 显示虚拟鼠标 + 操作标签', () => {
    act(() => emit({ op: 'lingji_update_card', title: '更新卡片', phase: 'start', ts: 1 }));
    expect(overlay()).toBeTruthy();
    expect(chip()?.textContent).toContain('更新卡片');
    expect(container.textContent).toContain('AI');
  });

  it('任务型 success → 标签提示交接到底部进度', () => {
    act(() => emit({ op: 'lingji_generate_audio', title: '生成口播音频(TTS)', phase: 'success', ts: 1 }));
    expect(chip()?.textContent).toContain('已提交，进度见底部');
  });

  it('error 事件 → 标签带失败信息', () => {
    act(() => emit({ op: 'lingji_update_card', title: '更新卡片', phase: 'error', error: '卡片不存在', ts: 1 }));
    expect(chip()?.textContent).toContain('失败');
    expect(chip()?.textContent).toContain('卡片不存在');
  });

  it('驻留时长后自动隐藏', () => {
    act(() => emit({ op: 'lingji_get_card', title: '读取卡片', phase: 'start', ts: 1 }));
    expect(overlay()).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(overlay()).toBeNull();
  });

  it('连续事件重置计时并更新标签', () => {
    act(() => emit({ op: 'lingji_get_card', title: '读取卡片', phase: 'start', ts: 1 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => emit({ op: 'lingji_update_card', title: '更新卡片', phase: 'start', ts: 2 }));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(chip()?.textContent).toContain('更新卡片');
  });
});
