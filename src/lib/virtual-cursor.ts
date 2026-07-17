// src/lib/virtual-cursor.ts
import { StateField, StateEffect } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
} from '@codemirror/view';

// ── Effects ───────────────────────────────────────────
export const setVirtualCursor = StateEffect.define<number>();
export const clearVirtualCursor = StateEffect.define<null>();
export const setVirtualCursorMode = StateEffect.define<'generate' | 'review'>();

// ── 光标位置 Field ────────────────────────────────────
export const virtualCursorField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVirtualCursor)) return effect.value;
      if (effect.is(clearVirtualCursor)) return null;
    }
    // 如果文档发生变化且光标存在，映射位置
    if (value !== null && tr.docChanged) {
      return tr.changes.mapPos(value);
    }
    return value;
  },
});

// ── 模式 Field ────────────────────────────────────────
export const virtualCursorModeField = StateField.define<'generate' | 'review'>({
  create: () => 'generate',
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVirtualCursorMode)) return effect.value;
    }
    return value;
  },
});

// ── Widget ────────────────────────────────────────────
class VirtualCursorWidget extends WidgetType {
  constructor(private mode: 'generate' | 'review') {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `cm-virtual-cursor cm-virtual-cursor-${this.mode}`;

    const cursor = document.createElement('span');
    cursor.className = 'cm-virtual-cursor-line';

    const label = document.createElement('span');
    label.className = 'cm-virtual-cursor-label';
    label.textContent = 'AI';

    wrapper.appendChild(label);
    wrapper.appendChild(cursor);
    return wrapper;
  }

  eq(other: VirtualCursorWidget): boolean {
    return this.mode === other.mode;
  }
}

// ── 装饰 Field（读取位置 + 模式，渲染 Widget）─────────
const virtualCursorDecoration = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_, tr) {
    const pos = tr.state.field(virtualCursorField);
    if (pos === null) return Decoration.none;
    const mode = tr.state.field(virtualCursorModeField);
    const clampedPos = Math.min(pos, tr.state.doc.length);
    return Decoration.set([
      Decoration.widget({ widget: new VirtualCursorWidget(mode), side: 1 }).range(
        clampedPos,
      ),
    ]);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── 审稿行高亮 Field ─────────────────────────────────
export const setReviewHighlightLine = StateEffect.define<number | null>();

const reviewLineHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewHighlightLine)) {
        const lineNum = effect.value;
        if (lineNum === null || lineNum < 1 || lineNum > tr.state.doc.lines) {
          return Decoration.none;
        }
        const line = tr.state.doc.line(lineNum);
        return Decoration.set([
          Decoration.line({ class: 'cm-review-scan-line' }).range(line.from),
        ]);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── CSS 样式 ──────────────────────────────────────────
const virtualCursorTheme = EditorView.baseTheme({
  // 共用
  '.cm-virtual-cursor': {
    position: 'relative',
    display: 'inline',
  },
  '.cm-virtual-cursor-label': {
    position: 'absolute',
    top: '-1.4em',
    left: '-4px',
    fontSize: '10px',
    lineHeight: '1',
    fontWeight: '600',
    letterSpacing: '0',
    color: 'var(--color-system-blue, #0A84FF)',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  // 生成与审查共用系统蓝，行为差异由阶段文案和内容反馈表达。
  '.cm-virtual-cursor-generate .cm-virtual-cursor-line, .cm-virtual-cursor-review .cm-virtual-cursor-line': {
    display: 'inline-block',
    width: '2px',
    height: '1.2em',
    backgroundColor: 'var(--color-system-blue, #0A84FF)',
    verticalAlign: 'text-bottom',
    animation: 'cm-vc-blink 1s step-end infinite',
  },
  '@keyframes cm-vc-blink': {
    '50%': { opacity: '0' },
  },
  // 审稿定位使用同一系统蓝的低对比行提示。
  '.cm-review-scan-line': {
    backgroundColor: 'color-mix(in srgb, var(--color-system-blue, #0A84FF) 8%, transparent)',
    borderLeft: '2px solid color-mix(in srgb, var(--color-system-blue, #0A84FF) 55%, transparent)',
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-virtual-cursor-line': {
      animation: 'none',
    },
  },
});

/** 完整的虚拟光标扩展，包含 StateField + 装饰 + 主题 */
export const virtualCursorExtension = [
  virtualCursorField,
  virtualCursorModeField,
  virtualCursorDecoration,
  reviewLineHighlight,
  virtualCursorTheme,
];
