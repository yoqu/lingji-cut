// src/lib/streaming-editor.ts
import { EditorView } from '@codemirror/view';
import { setVirtualCursor, clearVirtualCursor } from './virtual-cursor';

// Re-export types from diff-to-frames for convenience
export type { StreamingEditOperation, AnimationFrame } from './diff-to-frames';
import type { AnimationFrame, StreamingEditOperation } from './diff-to-frames';

export type StreamingSpeed = 'fast' | 'normal' | 'detailed';

export interface StreamingEditorOptions {
  speed?: StreamingSpeed;
  onProgress?: (percent: number) => void;
  onComplete?: () => void;
  onStopped?: (committedContent: string) => void;
}

const SPEED_MULTIPLIER: Record<StreamingSpeed, number> = {
  fast: 0.3,
  normal: 1,
  detailed: 2,
};

export class StreamingEditor {
  private view: EditorView;
  private frames: AnimationFrame[] = [];
  private currentIndex = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private options: Required<StreamingEditorOptions>;
  private _isPlaying = false;

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  constructor(view: EditorView, options: StreamingEditorOptions = {}) {
    this.view = view;
    this.options = {
      speed: options.speed ?? 'normal',
      onProgress: options.onProgress ?? (() => {}),
      onComplete: options.onComplete ?? (() => {}),
      onStopped: options.onStopped ?? (() => {}),
    };
  }

  start(frames: AnimationFrame[]): void {
    this.frames = frames;
    this.currentIndex = 0;
    this._isPlaying = true;
    this.scheduleNext();
  }

  stop(): void {
    this.cancelTimer();
    this._isPlaying = false;
    this.view.dispatch({ effects: clearVirtualCursor.of(null) });
    this.options.onStopped(this.view.state.doc.toString());
  }

  setSpeed(speed: StreamingSpeed): void {
    this.options.speed = speed;
  }

  private scheduleNext(): void {
    if (this.currentIndex >= this.frames.length) {
      this._isPlaying = false;
      this.view.dispatch({ effects: clearVirtualCursor.of(null) });
      this.options.onComplete();
      return;
    }

    const frame = this.frames[this.currentIndex];
    const delay = frame.delayMs * SPEED_MULTIPLIER[this.options.speed];

    this.timerId = setTimeout(() => {
      this.applyFrame(frame);
      this.currentIndex++;
      this.options.onProgress(
        Math.round((this.currentIndex / this.frames.length) * 100),
      );
      this.scheduleNext();
    }, delay);
  }

  /** 判断编辑器是否滚动到底部附近，用于决定是否自动跟随 */
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
    const { operation } = frame;
    const changes = this.operationToChange(operation);
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

  private cancelTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
