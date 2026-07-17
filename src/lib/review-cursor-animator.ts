/**
 * 审稿动画控制器
 *
 * 两阶段设计：
 * 1. breathing — 编辑器等待标记（等待 LLM 响应期间）
 * 2. annotating — 虚拟光标逐个定位到批注位置，揭示问题
 *
 * breathing 是兼容既有 store 的状态名，由外层 CSS 显示克制边缘提示（不涉及 CM6 操作），
 * annotating 阶段使用 CM6 虚拟光标 + 行高亮。
 */
import type { EditorView } from '@codemirror/view';
import {
  setVirtualCursor,
  clearVirtualCursor,
  setVirtualCursorMode,
  setReviewHighlightLine,
} from './virtual-cursor';

export interface ReviewCursorPosition {
  x: number;
  y: number;
}

export type ReviewPhase = 'breathing' | 'annotating' | 'complete';

export interface ReviewCursorAnimatorOptions {
  /** 批注揭示前停留时间（ms），默认 500 */
  annotationPauseMs?: number;
  /** 批注揭示后停留时间（ms），默认 350 */
  annotationPostPauseMs?: number;
  /** 光标屏幕坐标变化 */
  onCursorMove?: (pos: ReviewCursorPosition | null) => void;
  /** 阶段变化 */
  onPhaseChange?: (phase: ReviewPhase) => void;
  /** 第 index 个批注被揭示 */
  onAnnotationReveal?: (index: number) => void;
}

const DEFAULTS = {
  annotationPauseMs: 500,
  annotationPostPauseMs: 350,
};

export class ReviewCursorAnimator {
  private view: EditorView;
  private opts: Required<ReviewCursorAnimatorOptions>;
  private stopped = false;
  /** 用户是否手动滚动过，一旦为 true 则停止自动跟随 */
  private userScrolled = false;
  /** 最近一次程序触发滚动的时间戳，用于过滤 scroll 事件 */
  private lastProgrammaticScrollTime = 0;
  private scrollHandler: (() => void) | null = null;

  constructor(view: EditorView, options: ReviewCursorAnimatorOptions = {}) {
    this.view = view;
    this.opts = {
      annotationPauseMs: options.annotationPauseMs ?? DEFAULTS.annotationPauseMs,
      annotationPostPauseMs: options.annotationPostPauseMs ?? DEFAULTS.annotationPostPauseMs,
      onCursorMove: options.onCursorMove ?? (() => {}),
      onPhaseChange: options.onPhaseChange ?? (() => {}),
      onAnnotationReveal: options.onAnnotationReveal ?? (() => {}),
    };
  }

  /** 开始监听用户滚动，区分程序滚动与用户手动滚动 */
  private startScrollTracking(): void {
    this.userScrolled = false;
    this.scrollHandler = () => {
      // 100ms 内的 scroll 事件视为程序触发，忽略
      if (Date.now() - this.lastProgrammaticScrollTime < 100) return;
      this.userScrolled = true;
    };
    this.view.scrollDOM.addEventListener('scroll', this.scrollHandler);
  }

  private stopScrollTracking(): void {
    if (this.scrollHandler) {
      this.view.scrollDOM.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
  }

  // ── 阶段 1：等待响应（仅通知外层，不操作 CM6）────────

  startBreathing(): void {
    if (this.stopped) return;
    this.opts.onPhaseChange('breathing');
  }

  // ── 阶段 2：逐个揭示批注 ─────────────────────────────

  async animateAnnotations(offsets: number[]): Promise<void> {
    if (this.stopped) return;

    // 开始追踪用户滚动
    this.startScrollTracking();

    // 切换虚拟光标为审稿模式
    this.view.dispatch({ effects: setVirtualCursorMode.of('review') });
    this.opts.onPhaseChange('annotating');

    for (let i = 0; i < offsets.length; i++) {
      if (this.stopped) break;

      const offset = offsets[i];
      const lineNum = this.view.state.doc.lineAt(offset).number;

      const shouldScroll = !this.userScrolled;
      if (shouldScroll) this.lastProgrammaticScrollTime = Date.now();

      // 跳转光标到批注位置
      this.view.dispatch({
        effects: [
          setVirtualCursor.of(offset),
          setReviewHighlightLine.of(lineNum),
        ],
        scrollIntoView: shouldScroll,
      });
      this.reportScreenPos(offset);

      // 停留：模拟"发现问题"
      await this.delay(this.opts.annotationPauseMs);
      if (this.stopped) break;

      // 揭示批注
      this.opts.onAnnotationReveal(i);

      // 短暂停留后移到下一个
      await this.delay(this.opts.annotationPostPauseMs);
    }

    if (!this.stopped) {
      this.complete();
    }
  }

  // ── 停止 & 清理 ──────────────────────────────────────

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopScrollTracking();
    this.clearCursorState();
  }

  private complete(): void {
    this.stopScrollTracking();
    this.opts.onPhaseChange('complete');
    this.clearCursorState();
  }

  private clearCursorState(): void {
    this.view.dispatch({
      effects: [
        clearVirtualCursor.of(null),
        setReviewHighlightLine.of(null),
        setVirtualCursorMode.of('generate'),
      ],
    });
    this.opts.onCursorMove(null);
  }

  // ── 辅助 ─────────────────────────────────────────────

  private reportScreenPos(docPos: number): void {
    const coords = this.view.coordsAtPos(docPos);
    if (coords) {
      this.opts.onCursorMove({ x: coords.left, y: coords.top });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (this.stopped) {
          clearTimeout(id);
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 10);
    });
  }
}
