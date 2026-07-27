import { useCallback, useState } from 'react';
import { ArrowDownToLine, FilePlus2, FolderOpen, Import, Newspaper, PenSquare, Sparkles, Search } from 'lucide-react';
import { useScriptStore } from '../../store/script';
import { Button } from '../../ui';

interface EmptyGuideProps {
  hasProjectDir: boolean;
  onSelectProjectDir: () => void;
  onImportText: () => void;
  onImportDouyin: () => void;
  onImportWechat: () => void;
  onCreateBlank: () => void;
  onDropFile?: (relativePath: string) => void;
}

/**
 * 根据工作流状态展示不同引导：
 * - 无工作目录 → 选择工作目录
 * - 有目录但无原稿 → 导入原稿 / 新建空白
 * - 有原稿无口播稿 → 引导生成口播稿
 * - 有口播稿但未审稿 → 引导审查口播稿
 */
export function EmptyGuide({
  hasProjectDir,
  onSelectProjectDir,
  onImportText,
  onImportDouyin,
  onImportWechat,
  onCreateBlank,
  onDropFile,
}: EmptyGuideProps) {
  const workspaceFiles = useScriptStore((s) => s.workspaceFiles);
  const generateScriptCb = useScriptStore((s) => s.workbenchCallbacks.generateScript);
  const reviewScriptCb = useScriptStore((s) => s.workbenchCallbacks.reviewScript);
  const [dragOver, setDragOver] = useState(false);

  // 有原稿但没有口播稿：引导生成
  const showGenerateGuide =
    hasProjectDir && workspaceFiles.hasOriginalFile && !workspaceFiles.hasScriptFile;

  // 有口播稿：引导打开编辑（这个 case 通常不会到 EmptyGuide，但防御性处理）
  const showReviewGuide =
    hasProjectDir && workspaceFiles.hasScriptFile;

  // 可接受拖放：有工作目录且无原稿时
  const canDrop = hasProjectDir && !workspaceFiles.hasOriginalFile && Boolean(onDropFile);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!canDrop) return;
      if (!e.dataTransfer.types.includes('application/x-workbench-file')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    },
    [canDrop],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // 仅在离开容器时取消高亮（忽略子元素触发的 leave）
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!canDrop) return;
      const relativePath = e.dataTransfer.getData('application/x-workbench-file');
      if (relativePath) {
        onDropFile?.(relativePath);
      }
    },
    [canDrop, onDropFile],
  );

  // 有原稿、无口播稿 → 引导直接生成
  if (showGenerateGuide) {
    return (
      <div style={containerStyle}>
        <div style={iconContainerStyle('var(--color-system-blue)')}>
          <Sparkles size={24} />
        </div>
        <div style={textGroupStyle}>
          <div style={titleStyle}>原稿已就绪</div>
          <div style={descStyle}>
            根据原稿内容、当前角色和模板生成口播稿
          </div>
        </div>
        <div style={buttonGroupStyle}>
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Sparkles size={16} />}
            onClick={() => generateScriptCb && void generateScriptCb()}
            disabled={!generateScriptCb}
          >
            生成口播稿
          </Button>
        </div>
      </div>
    );
  }

  // 有口播稿 → 提示审稿
  if (showReviewGuide) {
    return (
      <div style={containerStyle}>
        <div style={iconContainerStyle('#0a84ff')}>
          <Search size={24} />
        </div>
        <div style={textGroupStyle}>
          <div style={titleStyle}>口播稿已生成</div>
          <div style={descStyle}>
            打开口播稿继续编辑，或先生成逐条审查建议
          </div>
        </div>
        <div style={buttonGroupStyle}>
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Search size={16} />}
            onClick={() => reviewScriptCb && void reviewScriptCb()}
            disabled={!reviewScriptCb}
          >
            审查口播稿
          </Button>
        </div>
      </div>
    );
  }

  // 无工作目录 / 无原稿 → 导入或创建
  return (
    <div
      style={{
        ...containerStyle,
        ...(dragOver ? dropZoneActiveStyle : canDrop ? dropZoneReadyStyle : undefined),
      }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div style={iconContainerStyle('var(--color-system-blue)')}>
        {dragOver ? <Import size={24} /> : <FilePlus2 size={24} />}
      </div>
      <div style={textGroupStyle}>
        <div style={titleStyle}>
          {dragOver
            ? '松开即可导入为原稿'
            : hasProjectDir
              ? '导入原稿，开始写作'
              : '先选择工作目录'}
        </div>
        <div style={descStyle}>
          {dragOver
            ? '文件内容将被写入 original.md'
            : hasProjectDir
              ? '可以导入现有文本文件、抓取公众号文章，从左侧文件树拖入，或直接创建一个空白 original.md。'
              : '工作目录会承载 original.md、script.md 和脚本状态文件。选择后即可导入原稿。'}
        </div>
      </div>
      {!dragOver && (
        <>
          <div style={buttonGroupStyle}>
            {!hasProjectDir ? (
              <Button
                variant="primary"
                size="lg"
                leftIcon={<FolderOpen size={16} />}
                onClick={onSelectProjectDir}
              >
                选择工作目录
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="lg"
              leftIcon={<Import size={16} />}
              onClick={onImportText}
            >
              导入文本文件
            </Button>
            <Button
              variant="outline"
              size="lg"
              leftIcon={<Newspaper size={16} />}
              onClick={onImportWechat}
            >
              公众号文章
            </Button>
            <Button
              variant="outline"
              size="lg"
              leftIcon={<Import size={16} />}
              onClick={onImportDouyin}
            >
              导入媒体
            </Button>
            <Button
              variant="outline"
              size="lg"
              leftIcon={<PenSquare size={16} />}
              onClick={onCreateBlank}
            >
              新建空白文稿
            </Button>
          </div>
          {canDrop && (
            <div style={dragHintStyle}>
              <ArrowDownToLine size={14} />
              <span>也可以从左侧文件树拖拽文件到此处导入</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── 样式 ─────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  height: '100%',
  padding: 24,
  textAlign: 'center',
};

const iconContainerStyle = (color: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 54,
  height: 54,
  borderRadius: 16,
  background: `color-mix(in srgb, ${color} 14%, transparent)`,
  color,
});

const textGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 420,
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
};

const descStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.7,
};

const buttonGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  justifyContent: 'center',
};

const dragHintStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px dashed var(--color-border-subtle)',
  background: 'color-mix(in srgb, var(--color-text-tertiary) 6%, transparent)',
  color: 'var(--color-text-tertiary)',
  fontSize: 12,
};

const dropZoneReadyStyle: React.CSSProperties = {
  transition: 'border-color 0.2s, background 0.2s',
};

const dropZoneActiveStyle: React.CSSProperties = {
  borderRadius: 16,
  border: '2px dashed #34c759',
  background: 'color-mix(in srgb, #34c759 8%, transparent)',
  transition: 'border-color 0.2s, background 0.2s',
};
