import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfirmDialog, Select, type SelectOption } from '../ui';
import { AppIcon } from './AppIcon';
import { CoverEditorCanvas } from './cover-editor/CoverEditorCanvas';
import type { CoverEditorCanvasHandle } from '../lib/cover-editor/fabric-bridge';
import { ToolRail, type EditorTool } from './cover-editor/ToolRail';
import { Inspector } from './cover-editor/Inspector';
import { FilterPanel } from './cover-editor/FilterPanel';
import { FontPicker } from './cover-editor/FontPicker';
import { CropPanel } from './cover-editor/CropPanel';
import {
  ASPECT_RATIO_PRESETS,
  resolveAspectRatio,
} from '../lib/cover-editor/aspect-ratios';
import {
  createEmptyEditState,
  normalizeEditState,
} from '../lib/cover-editor/cover-edit-state';
import { getPresetAdjustments } from '../lib/cover-editor/filters';
import type {
  AspectRatioPreset,
  CoverEditState,
  CoverSaveMode,
  CoverTextOverlay,
  FilterPreset,
} from '../lib/cover-editor/contracts';
import styles from './CoverEditorModal.module.css';

interface CoverEditorModalProps {
  open: boolean;
  candidateId: string;
  imageUrl: string;
  prompt: string;
  initialEdits?: CoverEditState;
  timelineSize: { width: number; height: number };
  onClose: () => void;
  onSaveRequested: (args: {
    mode: CoverSaveMode;
    dataUrl: string;
    edits: CoverEditState;
  }) => void;
}

export function CoverEditorModal({
  open,
  candidateId: _candidateId,
  imageUrl,
  prompt,
  initialEdits,
  timelineSize,
  onClose,
  onSaveRequested,
}: CoverEditorModalProps) {
  const canvasRef = useRef<CoverEditorCanvasHandle>(null);
  const [activeTool, setActiveTool] = useState<EditorTool>('select');
  const [preset, setPreset] = useState<AspectRatioPreset>(
    initialEdits?.aspectRatio ?? 'timeline',
  );
  const [filterPreset, setFilterPreset] = useState<FilterPreset>(
    initialEdits?.filters?.preset ?? 'none',
  );
  const [selectedText, setSelectedText] = useState<CoverTextOverlay | null>(null);
  const [saveMode, setSaveMode] = useState<CoverSaveMode>('append');
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'close' | 'overwrite' | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const initialRatio = useMemo(
    () => resolveAspectRatio(preset, timelineSize),
    [preset, timelineSize],
  );

  const handleCancel = useCallback(() => {
    if (dirty) {
      setConfirmAction('close');
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (confirmAction) return;
      // 若当前焦点在 input/textarea/canvas 上，跳过模态快捷键拦截（让 Fabric / 表单自然处理）
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'Escape') {
        handleCancel();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) canvasRef.current?.redo();
        else canvasRef.current?.undo();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmAction, open, handleCancel]);

  function handleAspectChange(next: AspectRatioPreset) {
    setPreset(next);
    const ratio = resolveAspectRatio(next, timelineSize);
    canvasRef.current?.setAspectRatio(ratio);
    setDirty(true);
  }

  function handleAddText() {
    canvasRef.current?.addText({
      text: '标题',
      fontFamily: 'PingFang SC',
      color: '#ffffff',
    });
    setDirty(true);
  }

  function handleSelectTool(tool: EditorTool) {
    const prev = activeTool;
    // 退出裁剪模式（若之前在裁剪）
    if (prev === 'crop' && tool !== 'crop') {
      canvasRef.current?.exitCropMode();
    }
    setActiveTool(tool);
    if (tool === 'text') handleAddText();
    if (tool === 'crop') canvasRef.current?.enterCropMode();
  }

  function handleCommitCrop() {
    canvasRef.current?.commitCrop();
    setActiveTool('select');
    setDirty(true);
  }

  function handleCancelCrop() {
    canvasRef.current?.exitCropMode();
    setActiveTool('select');
  }

  function commitSave(mode: CoverSaveMode) {
    const dataUrl = canvasRef.current?.exportDataUrl() ?? '';
    const edits = canvasRef.current?.getEditState() ?? createEmptyEditState();
    onSaveRequested({ mode, dataUrl, edits: { ...edits, aspectRatio: preset } });
  }

  function handleSave(mode: CoverSaveMode) {
    if (mode === 'overwrite') {
      setConfirmAction('overwrite');
      return;
    }
    commitSave(mode);
  }

  const aspectOptions: SelectOption[] = useMemo(
    () =>
      ASPECT_RATIO_PRESETS.map((p) => ({
        value: p.id,
        label:
          p.id === 'timeline'
            ? `时间线 ${timelineSize.width}×${timelineSize.height}`
            : p.label,
      })),
    [timelineSize.width, timelineSize.height],
  );

  const adjustments = getPresetAdjustments(filterPreset);

  if (!open || !mounted) return null;

  const modalNode = (
    <>
      <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        // 只在直接点击 backdrop 时才关闭；点击 modal 内部不触发
        if (e.target === e.currentTarget) handleCancel();
      }}
      role="presentation"
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.title}>
            编辑封面 · {prompt.slice(0, 24) || '未命名'}
          </div>
          <div className={styles.headerActions}>
            <Select
              value={preset}
              options={aspectOptions}
              onChange={(e) =>
                handleAspectChange(e.target.value as AspectRatioPreset)
              }
              controlClassName={styles.aspectSelect}
            />
            {activeTool === 'crop' && (
              <>
                <Button variant="ghost" size="sm" onClick={handleCancelCrop}>
                  取消裁剪
                </Button>
                <Button variant="primary" size="sm" onClick={handleCommitCrop}>
                  应用裁剪
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              关闭
            </Button>
            <div className={styles.saveSplit}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleSave(saveMode)}
              >
                {saveMode === 'append' ? '另存为新候选' : '覆盖原图'}
              </Button>
              <Button.Icon
                variant="primary"
                onClick={() => setSaveMenuOpen((v) => !v)}
                aria-label="切换保存模式"
              >
                <AppIcon name="chevron-down" size={12} />
              </Button.Icon>
              {saveMenuOpen && (
                <div className={styles.saveMenu}>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMode('append');
                      setSaveMenuOpen(false);
                    }}
                  >
                    另存为新候选
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMode('overwrite');
                      setSaveMenuOpen(false);
                    }}
                  >
                    覆盖原图
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className={styles.body}>
          <ToolRail
            activeTool={activeTool}
            onSelectTool={handleSelectTool}
            onUndo={() => canvasRef.current?.undo()}
            onRedo={() => canvasRef.current?.redo()}
            canUndo
            canRedo
          />

          <div className={styles.canvasArea}>
            <CoverEditorCanvas
              ref={canvasRef}
              imageUrl={imageUrl}
              initialEdits={
                initialEdits ? normalizeEditState(initialEdits) : undefined
              }
              initialAspectRatio={initialRatio}
              onChange={() => setDirty(true)}
              onTextSelectionChange={(t) => setSelectedText(t)}
            />
          </div>

          {activeTool === 'crop' ? (
            <CropPanel
              timelineSize={timelineSize}
              onAspectChange={(ratio) =>
                canvasRef.current?.setCropAspectRatio(ratio)
              }
              onApply={handleCommitCrop}
              onCancel={handleCancelCrop}
            />
          ) : activeTool === 'filter' || activeTool === 'adjust' ? (
            <FilterPanel
              preset={filterPreset}
              adjustments={adjustments}
              onPresetChange={(p) => {
                setFilterPreset(p);
                canvasRef.current?.setFilterPreset(p);
              }}
              onAdjustmentChange={(k, v) =>
                canvasRef.current?.setFilterAdjustment(k, v)
              }
            />
          ) : activeTool === 'transform' ? (
            <aside className={styles.transformPanel}>
              <div className={styles.sectionTitle}>变换</div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => canvasRef.current?.rotate(-90)}
                leftIcon={<AppIcon name="refresh-cw" size={12} />}
              >
                逆时针旋转 90°
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => canvasRef.current?.rotate(90)}
                leftIcon={<AppIcon name="refresh-cw" size={12} />}
              >
                顺时针旋转 90°
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => canvasRef.current?.flipHorizontal()}
              >
                水平翻转
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => canvasRef.current?.flipVertical()}
              >
                垂直翻转
              </Button>
            </aside>
          ) : (
            <Inspector
              selectedText={selectedText}
              onUpdateText={(patch) => {
                if (!selectedText) return;
                const nextState = { ...selectedText, ...patch };
                setSelectedText(nextState);
                canvasRef.current?.updateSelectedText(patch);
                setDirty(true);
              }}
              onRemoveText={() => {
                canvasRef.current?.removeSelected();
                setSelectedText(null);
              }}
              fontFamilyPicker={
                <FontPicker
                  value={selectedText?.fontFamily ?? 'PingFang SC'}
                  onChange={(family) => {
                    if (!selectedText) return;
                    setSelectedText({ ...selectedText, fontFamily: family });
                    canvasRef.current?.updateSelectedText({ fontFamily: family });
                  }}
                />
              }
            />
          )}
        </div>
      </div>
      </div>
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmAction(null);
        }}
        title={confirmAction === 'close' ? '放弃未保存的修改？' : '覆盖原图？'}
        description={
          confirmAction === 'close'
            ? '关闭后，本次封面编辑将不会保存。'
            : '当前候选图片将被替换，且无法恢复。'
        }
        confirmText={confirmAction === 'close' ? '放弃修改' : '覆盖原图'}
        confirmVariant="destructive"
        onConfirm={() => {
          if (confirmAction === 'close') onClose();
          if (confirmAction === 'overwrite') commitSave('overwrite');
        }}
      />
    </>
  );

  return createPortal(modalNode, document.body);
}
