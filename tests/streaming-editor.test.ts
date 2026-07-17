import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingEditor } from '../src/lib/streaming-editor';
import type { AnimationFrame } from '../src/lib/streaming-editor';

vi.mock('@codemirror/view', () => ({
  EditorView: {
    scrollIntoView: (position: number, options: unknown) => ({
      type: 'scrollIntoView',
      position,
      options,
    }),
  },
}));

// Mock virtual-cursor effects to avoid CodeMirror state dependencies
vi.mock('../src/lib/virtual-cursor', () => ({
  setVirtualCursor: { of: (v: any) => ({ type: 'setVirtualCursor', value: v }) },
  clearVirtualCursor: { of: (v: any) => ({ type: 'clearVirtualCursor', value: v }) },
}));

// Mock EditorView — 使用 getter 正确跟踪 doc 状态
function makeMockView(initialDoc = '') {
  let doc = initialDoc;
  const view = {
    state: {
      doc: {
        get length() { return doc.length; },
        toString: () => doc,
      },
    },
    dispatch: vi.fn((spec: any) => {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        doc = doc.slice(0, from) + (insert || '') + doc.slice(to ?? from);
      }
    }),
    destroy: vi.fn(),
  };
  return view;
}

describe('StreamingEditor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('plays frames sequentially and calls onComplete', async () => {
    const mockView = makeMockView('');
    const onComplete = vi.fn();
    const onProgress = vi.fn();
    const controller = new StreamingEditor(mockView as any, {
      onComplete,
      onProgress,
    });

    const frames: AnimationFrame[] = [
      { cursorPosition: 0, operation: { type: 'insert', offset: 0, text: 'Hello' }, delayMs: 100 },
      { cursorPosition: 5, operation: { type: 'insert', offset: 5, text: ' World' }, delayMs: 100 },
    ];

    controller.start(frames);
    expect(controller.isPlaying).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(onProgress).toHaveBeenCalledWith(50);
    expect(mockView.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            type: 'scrollIntoView',
            position: 0,
            options: { y: 'end' },
          }),
        ]),
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(onComplete).toHaveBeenCalled();
    expect(controller.isPlaying).toBe(false);
  });

  it('stop() halts playback and returns committed content', async () => {
    const mockView = makeMockView('');
    const onStopped = vi.fn();
    const controller = new StreamingEditor(mockView as any, { onStopped });

    const frames: AnimationFrame[] = [
      { cursorPosition: 0, operation: { type: 'insert', offset: 0, text: 'A' }, delayMs: 50 },
      { cursorPosition: 1, operation: { type: 'insert', offset: 1, text: 'B' }, delayMs: 50 },
      { cursorPosition: 2, operation: { type: 'insert', offset: 2, text: 'C' }, delayMs: 50 },
    ];

    controller.start(frames);
    await vi.advanceTimersByTimeAsync(50); // 第一帧执行
    controller.stop();
    expect(onStopped).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledWith('A');
    expect(controller.isPlaying).toBe(false);

    // 继续推进时间，不应再有 dispatch
    const callCount = mockView.dispatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(mockView.dispatch.mock.calls.length).toBe(callCount);
  });
});
