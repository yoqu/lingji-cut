import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveStreamingEditor } from '../src/lib/live-streaming-editor';
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

vi.mock('../src/lib/virtual-cursor', () => ({
  setVirtualCursor: { of: (value: number) => ({ type: 'setVirtualCursor', value }) },
  clearVirtualCursor: { of: (_value: null) => ({ type: 'clearVirtualCursor' }) },
}));

function makeMockView(
  initialDoc = '',
  scrollDOM = { scrollTop: 0, scrollHeight: 0, clientHeight: 100 },
) {
  let doc = initialDoc;
  const view = {
    state: {
      doc: {
        get length() {
          return doc.length;
        },
        toString: () => doc,
      },
    },
    dispatch: vi.fn((spec: any) => {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        doc = doc.slice(0, from) + (insert ?? '') + doc.slice(to ?? from);
      }
    }),
    scrollDOM,
  };
  return view;
}

describe('LiveStreamingEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams text in small chunks and keeps virtual cursor active', async () => {
    const view = makeMockView('');
    const onComplete = vi.fn();
    const onProgress = vi.fn();
    const player = new LiveStreamingEditor(view as any, {
      chunkSize: 2,
      frameDelayMs: 20,
      onComplete,
      onProgress,
    });

    player.pushText('你好世界');
    const drained = player.finish();

    await vi.advanceTimersByTimeAsync(20);
    expect(view.state.doc.toString()).toBe('你好');

    await vi.advanceTimersByTimeAsync(20);
    await drained;

    expect(view.state.doc.toString()).toBe('你好世界');
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ committedChars: 4 }),
    );
    expect(onComplete).toHaveBeenCalledWith('你好世界');
    expect(
      view.dispatch.mock.calls.some(([spec]: any[]) =>
        Array.isArray(spec.effects)
          ? spec.effects.some((effect: any) => effect.type === 'setVirtualCursor')
          : spec.effects?.type === 'setVirtualCursor',
      ),
    ).toBe(true);
  });

  it('catches up faster when buffered text becomes too long', async () => {
    const view = makeMockView('');
    const player = new LiveStreamingEditor(view as any, {
      chunkSize: 2,
      frameDelayMs: 20,
    });

    player.pushText('这是一段明显长于基础步长的连续文本，用来验证播放器会主动追帧。');

    await vi.advanceTimersByTimeAsync(20);

    expect(view.state.doc.toString().length).toBeGreaterThan(2);
  });

  it('follows the AI cursor while near the bottom and pauses after the user scrolls up', async () => {
    const scrollDOM = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
    const view = makeMockView('', scrollDOM);
    const player = new LiveStreamingEditor(view as any, {
      chunkSize: 1,
      frameDelayMs: 20,
    });

    player.pushText('A');
    await vi.advanceTimersByTimeAsync(20);

    expect(view.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            type: 'scrollIntoView',
            position: 1,
            options: { y: 'end' },
          }),
        ]),
      }),
    );

    scrollDOM.scrollTop = 200;
    view.dispatch.mockClear();
    player.pushText('B');
    await vi.advanceTimersByTimeAsync(20);

    expect(
      view.dispatch.mock.calls.some(([spec]: any[]) =>
        Array.isArray(spec.effects) &&
        spec.effects.some((effect: any) => effect.type === 'scrollIntoView'),
      ),
    ).toBe(false);

    scrollDOM.scrollTop = 400;
    view.dispatch.mockClear();
    player.pushText('C');
    await vi.advanceTimersByTimeAsync(20);

    expect(
      view.dispatch.mock.calls.some(([spec]: any[]) =>
        Array.isArray(spec.effects) &&
        spec.effects.some((effect: any) => effect.type === 'scrollIntoView'),
      ),
    ).toBe(true);
  });

  it('stop commits current content and halts remaining playback', async () => {
    const view = makeMockView('');
    const onStopped = vi.fn();
    const player = new LiveStreamingEditor(view as any, {
      chunkSize: 1,
      frameDelayMs: 15,
      onStopped,
    });

    player.pushText('ABC');

    await vi.advanceTimersByTimeAsync(15);
    expect(view.state.doc.toString()).toBe('A');

    player.stop();
    expect(onStopped).toHaveBeenCalledWith('A');
    expect(player.isPlaying).toBe(false);

    const dispatchCount = view.dispatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60);
    expect(view.dispatch.mock.calls.length).toBe(dispatchCount);
    expect(view.state.doc.toString()).toBe('A');
  });

  it('can play diff frames so update_script shares the same playback engine', async () => {
    const view = makeMockView('Hello world');
    const onComplete = vi.fn();
    const player = new LiveStreamingEditor(view as any, {
      frameDelayMs: 10,
      onComplete,
    });

    const frames: AnimationFrame[] = [
      {
        cursorPosition: 6,
        operation: { type: 'delete', offset: 6, length: 5 },
        delayMs: 10,
      },
      {
        cursorPosition: 10,
        operation: { type: 'insert', offset: 6, text: 'Codex' },
        delayMs: 10,
      },
    ];

    player.pushFrames(frames);
    const drained = player.finish();

    await vi.advanceTimersByTimeAsync(20);
    await drained;

    expect(view.state.doc.toString()).toBe('Hello Codex');
    expect(onComplete).toHaveBeenCalledWith('Hello Codex');
  });

  it('finish resolves safely when no task has been queued yet', async () => {
    const view = makeMockView('已有内容');
    const onComplete = vi.fn();
    const player = new LiveStreamingEditor(view as any, {
      onComplete,
    });

    await expect(player.finish()).resolves.toBeUndefined();

    expect(view.state.doc.toString()).toBe('已有内容');
    expect(onComplete).toHaveBeenCalledWith('已有内容');
  });
});
