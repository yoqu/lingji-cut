// src/ui/components/script-editor.tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition } from './floating';
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { createSearchPanel } from './script-editor-search';
import type { Annotation, AnnotationSeverity } from '../../store/script';
import { scriptEditorTheme } from './script-editor-theme';
import {
  annotationField,
  annotationHoverTooltip,
  createAnnotationClickHandler,
  setAnnotationsEffect,
  type AnnotationClickInfo,
} from './script-editor-annotations';
import {
  clearVirtualCursor,
  setReviewHighlightLine,
  setVirtualCursor,
  setVirtualCursorMode,
  virtualCursorExtension,
} from '../../lib/virtual-cursor';
import { createReadOnlyGuard } from '../../lib/editor-readonly-guard';

// --- Severity display config ---

const SEVERITY_LABEL: Record<AnnotationSeverity, { color: string; text: string }> = {
  error: { color: 'var(--color-danger)', text: '错误' },
  warning: { color: 'var(--color-brand-warm)', text: '警告' },
  info: { color: 'var(--color-system-blue)', text: '建议' },
};

// --- AnnotationPopover ---

function AnnotationPopover({
  info,
  onAccept,
  onDismiss,
  onClose,
}: {
  info: AnnotationClickInfo;
  onAccept: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { annotation } = info;
  const severity = SEVERITY_LABEL[annotation.severity] ?? SEVERITY_LABEL.info;
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // 测量弹窗后做视口碰撞检测：右侧溢出时向左翻转，底部溢出时向上翻转，最后再钳制
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // info.y 是点击文本的 coords.bottom；以估算行高反推 triggerRect.top，便于上方翻转
    const estimatedLineHeight = 22;
    const next = computeFloatingPosition({
      triggerRect: {
        top: info.y - estimatedLineHeight,
        bottom: info.y,
        left: info.x,
        right: info.x,
        width: 0,
        height: estimatedLineHeight,
      },
      contentRect: { width: rect.width, height: rect.height },
      viewportRect: { width: window.innerWidth, height: window.innerHeight },
      side: 'bottom',
      align: 'start',
      sideOffset: 6,
      viewportPadding: 8,
    });
    setCoords(next);
  }, [info.x, info.y]);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: coords?.top ?? info.y + 6,
        left: coords?.left ?? info.x,
        visibility: coords ? 'visible' : 'hidden',
        zIndex: 9999,
        width: 320,
        maxWidth: 'calc(100vw - 16px)',
        padding: 14,
        borderRadius: 'var(--radius-xl)',
        backgroundColor: 'var(--color-panel-elevated)',
        border: `1px solid color-mix(in srgb, ${severity.color} 25%, transparent)`,
        boxShadow: 'var(--shadow-dropdown)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 'var(--font-size-md)',
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: severity.color,
          }}
        />
        <span style={{ color: severity.color, fontWeight: 600 }}>
          {severity.text}
        </span>
      </div>

      {/* issue */}
      <div style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        {annotation.issue}
      </div>

      {/* suggestion diff */}
      {annotation.suggestion && annotation.suggestion !== annotation.originalText && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: `color-mix(in srgb, ${severity.color} 3%, transparent)`,
            border: `1px solid color-mix(in srgb, ${severity.color} 12%, transparent)`,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>
            <span style={{ textDecoration: 'line-through' }}>
              {annotation.originalText}
            </span>
          </div>
          <div style={{ color: 'color-mix(in srgb, var(--color-text-primary) 80%, transparent)' }}>{annotation.suggestion}</div>
        </div>
      )}

      {/* actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: '6px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-strong)',
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontSize: 'var(--font-size-md)',
            cursor: 'pointer',
          }}
        >
          忽略
        </button>
        {annotation.suggestion && annotation.suggestion !== annotation.originalText ? (
          <button
            type="button"
            onClick={onAccept}
            style={{
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: severity.color,
              color: 'var(--color-text-primary)',
              fontSize: 'var(--font-size-md)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            采纳修改
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// --- MCP 变更行高亮 ---

const setHighlightLinesEffect = StateEffect.define<number[]>();

const highlightLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlightLinesEffect)) {
        const lines = effect.value;
        const decos: any[] = [];
        for (const lineNum of lines) {
          if (lineNum >= 1 && lineNum <= tr.state.doc.lines) {
            const line = tr.state.doc.line(lineNum);
            decos.push(Decoration.line({ class: 'cm-mcp-change-highlight' }).range(line.from));
          }
        }
        return Decoration.set(decos, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- ScriptEditor ---

interface ScriptEditorProps {
  /** 当前编辑器承载的文件标识；切换文件时用于清理文档级临时装饰。 */
  documentId?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  annotations?: Annotation[];
  onAcceptAnnotation?: (id: string) => void;
  onDismissAnnotation?: (id: string) => void;
  readOnly?: boolean;
  /** 流式写入进行中时为 true，跳过 React → CM6 的 value 同步以避免覆盖动画 */
  streamingActive?: boolean;
  editorViewRef?: React.MutableRefObject<EditorView | null>;
  mcpChangeHighlightLines?: number[];
  /** 外部请求聚焦到某条批注：滚动 + 行高亮 + 弹出建议（若 pending） */
  focusedAnnotationId?: string | null;
  /** 批注聚焦变化回调：外部点击编辑器批注或 popover 关闭时通知父组件 */
  onFocusedAnnotationChange?: (id: string | null) => void;
  /** 请求 token：即使 id 相同也能触发重新聚焦（用于"再次点击同一条"） */
  focusRequestToken?: number;
}

export function ScriptEditor({
  documentId,
  value,
  onChange,
  placeholder,
  annotations = [],
  onAcceptAnnotation,
  onDismissAnnotation,
  readOnly,
  streamingActive,
  editorViewRef,
  mcpChangeHighlightLines,
  focusedAnnotationId,
  onFocusedAnnotationChange,
  focusRequestToken,
}: ScriptEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const placeholderCompartment = useRef(new Compartment());
  const readOnlyGuard = useRef(createReadOnlyGuard());
  // 用 ref 引用最新批注，避免 focus effect 在每次 annotations 变化时重跑
  const annotationsRef = useRef<Annotation[]>(annotations);
  annotationsRef.current = annotations;
  const onFocusedChangeRef = useRef(onFocusedAnnotationChange);
  onFocusedChangeRef.current = onFocusedAnnotationChange;

  const [clickInfo, setClickInfo] = useState<AnnotationClickInfo | null>(null);

  // Initialize CM6 EditorView
  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          scriptEditorTheme,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          history(),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
          search({ top: true, createPanel: createSearchPanel }),
          highlightSelectionMatches(),
          placeholderCompartment.current.of(cmPlaceholder(placeholder ?? '')),
          annotationField,
          annotationHoverTooltip,
          createAnnotationClickHandler((info) => {
            setClickInfo(info);
            onFocusedChangeRef.current?.(info?.id ?? null);
          }),
          highlightLineField,
          ...virtualCursorExtension,
          readOnlyGuard.current.extension,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            contextmenu: (event) => {
              event.preventDefault();
              window.electronAPI?.showEditorContextMenu();
            },
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    if (editorViewRef) {
      editorViewRef.current = view;
    }
    return () => {
      view.destroy();
      if (editorViewRef) {
        editorViewRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React → CM6: sync external value changes
  // 流式写入期间跳过，避免覆盖 StreamingEditor 的动画帧
  useEffect(() => {
    if (streamingActive) return;
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (value !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value, streamingActive]);

  // 同一个 EditorView 会被多个工作台文件复用，虚拟光标和审稿行高亮不能跨文件继承。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        clearVirtualCursor.of(null),
        setReviewHighlightLine.of(null),
      ],
    });
    setClickInfo(null);
  }, [documentId]);

  // React → CM6: sync annotations
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setAnnotationsEffect.of(annotations) });
  }, [annotations]);

  // React → CM6: sync placeholder text
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(
        cmPlaceholder(placeholder ?? ''),
      ),
    });
  }, [placeholder]);

  // React → CM6: sync readOnly state
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.dispatch({
        effects: readOnlyGuard.current.reconfigure(readOnly ?? false),
      });
    }
  }, [readOnly]);

  // React → CM6: 同步 MCP 变更行高亮
  useEffect(() => {
    const view = viewRef.current;
    if (view && mcpChangeHighlightLines?.length) {
      view.dispatch({ effects: setHighlightLinesEffect.of(mcpChangeHighlightLines) });
    } else if (view) {
      view.dispatch({ effects: setHighlightLinesEffect.of([]) });
    }
  }, [mcpChangeHighlightLines]);

  // Close popover when the active annotation is no longer pending
  useEffect(() => {
    if (!clickInfo) return;
    const ann = annotations.find((a) => a.id === clickInfo.id);
    if (!ann || ann.status !== 'pending') {
      setClickInfo(null);
    }
  }, [annotations, clickInfo]);

  // 外部聚焦请求：滚动到批注位置，显示虚拟光标 + 行高亮 + popover（若 pending）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!focusedAnnotationId) {
      view.dispatch({
        effects: [
          clearVirtualCursor.of(null),
          setReviewHighlightLine.of(null),
        ],
      });
      setClickInfo(null);
      return;
    }

    const ann = annotationsRef.current.find((a) => a.id === focusedAnnotationId);
    if (!ann) return;

    const docLen = view.state.doc.length;
    const startOffset = Math.min(Math.max(ann.startOffset, 0), docLen);
    const lineNum = view.state.doc.lineAt(startOffset).number;

    view.dispatch({
      effects: [
        setVirtualCursorMode.of('review'),
        setVirtualCursor.of(startOffset),
        setReviewHighlightLine.of(lineNum),
      ],
      selection: { anchor: startOffset, head: startOffset },
      scrollIntoView: true,
    });
    view.focus();

    if (ann.status === 'pending') {
      // 等待下一帧，确保 scrollIntoView 完成后再读取坐标
      const raf = requestAnimationFrame(() => {
        const currentView = viewRef.current;
        if (!currentView) return;
        const coords = currentView.coordsAtPos(startOffset);
        if (coords) {
          setClickInfo({
            id: ann.id,
            annotation: ann,
            x: coords.left,
            y: coords.bottom,
          });
        }
      });
      return () => cancelAnimationFrame(raf);
    }

    setClickInfo(null);
  }, [focusedAnnotationId, focusRequestToken]);

  const handleClosePopover = useCallback(() => {
    setClickInfo(null);
    onFocusedChangeRef.current?.(null);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        overflow: 'hidden',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-separator)',
      }}
    >
      {clickInfo && (
        <AnnotationPopover
          info={clickInfo}
          onAccept={() => { onAcceptAnnotation?.(clickInfo.id); handleClosePopover(); }}
          onDismiss={() => { onDismissAnnotation?.(clickInfo.id); handleClosePopover(); }}
          onClose={handleClosePopover}
        />
      )}
    </div>
  );
}
