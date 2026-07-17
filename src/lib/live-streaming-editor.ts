import { EditorView } from '@codemirror/view';
import { clearVirtualCursor, setVirtualCursor } from './virtual-cursor';
import type { AnimationFrame, StreamingEditOperation } from './streaming-editor';

export interface LiveStreamingProgress {
  committedChars: number;
  receivedChars: number;
  processedSteps: number;
  totalSteps: number;
}

export interface LiveStreamingEditorOptions {
  chunkSize?: number;
  frameDelayMs?: number;
  minFrameDelayMs?: number;
  maxChunkSize?: number;
  catchUpThreshold?: number;
  onProgress?: (progress: LiveStreamingProgress) => void;
  onComplete?: (committedContent: string) => void;
  onStopped?: (committedContent: string) => void;
}

const DEFAULT_OPTIONS: Required<LiveStreamingEditorOptions> = {
  chunkSize: 3,
  frameDelayMs: 18,
  minFrameDelayMs: 5,
  maxChunkSize: 24,
  catchUpThreshold: 24,
  onProgress: () => {},
  onComplete: () => {},
  onStopped: () => {},
};

/**
 * 将实时到达的文本 chunk 转成稳定的“打字机”播放效果。
 * 适用于 LLM 流式生成这类“总长度未知，但希望持续可视化输入”的场景。
 */
export class LiveStreamingEditor {
  private readonly view: EditorView;
  private readonly options: Required<LiveStreamingEditorOptions>;
  private readonly pendingResolvers = new Set<() => void>();

  private queue: Array<
    | { kind: 'append-text'; text: string }
    | { kind: 'frame'; frame: AnimationFrame }
  > = [];
  private currentTask:
    | { kind: 'append-text'; text: string }
    | { kind: 'frame'; frame: AnimationFrame }
    | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private committedChars = 0;
  private receivedChars = 0;
  private totalSteps = 0;
  private processedSteps = 0;
  private streamClosed = false;
  private stopped = false;
  private _isPlaying = false;

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  constructor(view: EditorView, options: LiveStreamingEditorOptions = {}) {
    this.view = view;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  pushText(text: string): void {
    if (this.stopped || !text) return;

    if (this.currentTask?.kind === 'append-text') {
      this.currentTask.text += text;
    } else {
      const tail = this.queue[this.queue.length - 1];
      if (tail?.kind === 'append-text') {
        tail.text += text;
      } else {
        this.queue.push({ kind: 'append-text', text });
      }
    }
    this.receivedChars += text.length;
    this.totalSteps += Math.ceil(text.length / this.options.chunkSize);

    if (!this._isPlaying) {
      this._isPlaying = true;
      this.scheduleNext();
    }
  }

  pushFrames(frames: AnimationFrame[]): void {
    if (this.stopped || frames.length === 0) return;

    this.queue.push(...frames.map((frame) => ({ kind: 'frame' as const, frame })));
    this.totalSteps += frames.length;

    if (!this._isPlaying) {
      this._isPlaying = true;
      this.scheduleNext();
    }
  }

  finish(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    this.streamClosed = true;

    if (!this._isPlaying && !this.currentTask && this.queue.length === 0) {
      this.complete();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.pendingResolvers.add(resolve);
    });
  }

  stop(): void {
    if (this.stopped) return;

    this.stopped = true;
    this._isPlaying = false;
    this.streamClosed = true;
    this.queue = [];
    this.currentTask = null;
    this.cancelTimer();
    this.clearCursor();
    const committedContent = this.view.state.doc.toString();
    this.options.onStopped(committedContent);
    this.resolvePending();
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    if (!this.currentTask) {
      this.currentTask = this.queue.shift() ?? null;
    }

    if (!this.currentTask) {
      this._isPlaying = false;
      if (this.streamClosed) {
        this.complete();
      }
      return;
    }

    const delay = this.resolveStepDelay();

    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.flushNextStep();
      this.scheduleNext();
    }, delay);
  }

  private flushNextStep(): void {
    if (!this.currentTask) return;

    if (this.currentTask.kind === 'frame') {
      this.applyFrame(this.currentTask.frame);
      this.currentTask = null;
      this.processedSteps += 1;
      this.emitProgress();
      return;
    }

    const piece = this.getNextTextPiece(this.currentTask.text);
    this.currentTask.text = this.currentTask.text.slice(piece.length);
    if (!piece) {
      this.currentTask = null;
      return;
    }

    const from = this.view.state.doc.length;
    const cursorPosition = from + piece.length;
    const follow = this.isNearBottom();
    this.view.dispatch({
      changes: { from, insert: piece },
      effects: follow
        ? [
            setVirtualCursor.of(cursorPosition),
            EditorView.scrollIntoView(cursorPosition, { y: 'end' }),
          ]
        : setVirtualCursor.of(cursorPosition),
    });

    this.committedChars += piece.length;
    this.processedSteps += 1;
    this.emitProgress();

    if (!this.currentTask.text) {
      this.currentTask = null;
    }
  }

  private complete(): void {
    if (this.stopped) {
      this.resolvePending();
      return;
    }

    this.cancelTimer();
    this.clearCursor();
    this.options.onComplete(this.view.state.doc.toString());
    this.resolvePending();
  }

  private clearCursor(): void {
    this.view.dispatch({ effects: clearVirtualCursor.of(null) });
  }

  private cancelTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private resolvePending(): void {
    for (const resolve of this.pendingResolvers) {
      resolve();
    }
    this.pendingResolvers.clear();
  }

  private emitProgress(): void {
    this.options.onProgress({
      committedChars: this.committedChars,
      receivedChars: this.receivedChars,
      processedSteps: this.processedSteps,
      totalSteps: this.totalSteps,
    });
  }

  private resolveStepDelay(): number {
    if (!this.currentTask) {
      return this.options.frameDelayMs;
    }

    if (this.currentTask.kind === 'frame') {
      return this.currentTask.frame.delayMs;
    }

    const bufferedTextLength = this.getPendingTextLength();
    const paceLevel = Math.floor(bufferedTextLength / this.options.catchUpThreshold);
    let delay = Math.max(
      this.options.minFrameDelayMs,
      this.options.frameDelayMs - paceLevel * 4,
    );

    if (paceLevel === 0) {
      const preview = this.getNextTextPiece(this.currentTask.text);
      if (/\n$/.test(preview)) {
        delay += 26;
      } else if (/[，。！？；：,.!?;:]$/.test(preview)) {
        delay += 14;
      }
    }

    return delay;
  }

  private getPendingTextLength(): number {
    const currentLength =
      this.currentTask?.kind === 'append-text' ? this.currentTask.text.length : 0;
    const queuedLength = this.queue.reduce((sum, task) => {
      if (task.kind !== 'append-text') {
        return sum;
      }
      return sum + task.text.length;
    }, 0);

    return currentLength + queuedLength;
  }

  private getNextTextPiece(text: string): string {
    const bufferedTextLength = this.getPendingTextLength();
    const paceLevel = Math.floor(bufferedTextLength / this.options.catchUpThreshold);
    const dynamicChunkSize = Math.min(
      this.options.maxChunkSize,
      this.options.chunkSize + paceLevel * this.options.chunkSize,
    );

    if (text.length <= dynamicChunkSize) {
      return text;
    }

    const preview = text.slice(0, dynamicChunkSize + 1);
    const naturalBoundary = Math.max(
      preview.lastIndexOf('\n'),
      preview.lastIndexOf(' '),
      preview.lastIndexOf('，'),
      preview.lastIndexOf('。'),
      preview.lastIndexOf('！'),
      preview.lastIndexOf('？'),
      preview.lastIndexOf('；'),
      preview.lastIndexOf('：'),
      preview.lastIndexOf(','),
      preview.lastIndexOf('.'),
      preview.lastIndexOf('!'),
      preview.lastIndexOf('?'),
      preview.lastIndexOf(';'),
      preview.lastIndexOf(':'),
    );

    if (naturalBoundary >= Math.max(1, Math.floor(dynamicChunkSize * 0.6))) {
      return text.slice(0, naturalBoundary + 1);
    }

    return text.slice(0, dynamicChunkSize);
  }

  /**
   * 判断编辑器是否滚动到底部附近。
   * 若是则自动跟随滚动，若用户手动上滑则停止跟随，用户滑回底部则恢复。
   */
  private isNearBottom(): boolean {
    const scrollDOM = (this.view as EditorView & {
      scrollDOM?: { scrollTop: number; scrollHeight: number; clientHeight: number };
    }).scrollDOM;
    if (!scrollDOM) {
      return true;
    }
    const { scrollTop, scrollHeight, clientHeight } = scrollDOM;
    return scrollHeight - scrollTop - clientHeight < 50;
  }

  private applyFrame(frame: AnimationFrame): void {
    const changes = this.operationToChange(frame.operation);
    const follow = this.isNearBottom();
    this.view.dispatch({
      changes,
      effects: follow
        ? [
            setVirtualCursor.of(frame.cursorPosition),
            EditorView.scrollIntoView(frame.cursorPosition, { y: 'end' }),
          ]
        : setVirtualCursor.of(frame.cursorPosition),
    });
    this.committedChars = this.view.state.doc.length;
  }

  private operationToChange(op: StreamingEditOperation) {
    switch (op.type) {
      case 'insert':
        return { from: op.offset, insert: op.text ?? '' };
      case 'delete':
        return { from: op.offset, to: op.offset + (op.length ?? 0) };
      case 'replace':
        return {
          from: op.offset,
          to: op.offset + (op.length ?? 0),
          insert: op.text ?? '',
        };
    }
  }
}
