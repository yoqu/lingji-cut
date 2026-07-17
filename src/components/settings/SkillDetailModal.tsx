import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, FolderOpen, FolderClosed } from 'lucide-react';
import type {
  ResolvedAgentSkill,
  SkillFileContent,
  SkillTreeNode,
} from '../../../electron/acp/types';
import { Modal, Button } from '../../ui';
import { buildSafeMarkdownPreviewOptions } from '../../ui/lib/markdown-preview';
import '@uiw/react-markdown-preview/markdown.css';

// MDEditor 依赖 window/document，惰性加载其 Markdown 子组件避免首屏与 SSR 问题。
const Markdown = lazy(() =>
  import('@uiw/react-md-editor').then((m) => ({ default: m.default.Markdown })),
);

interface Props {
  skill: ResolvedAgentSkill | null;
  onClose: () => void;
}

/** 在树中找到首个匹配相对路径的文件节点（默认定位 SKILL.md）。 */
function findFile(node: SkillTreeNode | null, relPath: string): boolean {
  if (!node) return false;
  if (!node.isDir) return node.relPath === relPath;
  return (node.children ?? []).some((c) => findFile(c, relPath));
}

export function SkillDetailModal({ skill, onClose }: Props) {
  const [tree, setTree] = useState<SkillTreeNode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<SkillFileContent | { error: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const skillId = skill?.id ?? null;

  // 打开 / 切换 skill：拉取目录树，默认选中根 SKILL.md。
  useEffect(() => {
    if (!skillId || typeof window.agentAPI?.readSkillTree !== 'function') {
      setTree(null);
      setSelected(null);
      setContent(null);
      return;
    }
    let alive = true;
    void (async () => {
      const t = await window.agentAPI.readSkillTree(skillId);
      if (!alive) return;
      setTree(t);
      setSelected(t && findFile(t, 'SKILL.md') ? 'SKILL.md' : null);
    })();
    return () => {
      alive = false;
    };
  }, [skillId]);

  // 选中文件 → 拉取内容。
  useEffect(() => {
    if (!skillId || !selected || typeof window.agentAPI?.readSkillFile !== 'function') {
      setContent(null);
      return;
    }
    let alive = true;
    setLoadingFile(true);
    void (async () => {
      const res = await window.agentAPI.readSkillFile(skillId, selected);
      if (!alive) return;
      setContent(res);
      setLoadingFile(false);
    })();
    return () => {
      alive = false;
    };
  }, [skillId, selected]);

  const openInFinder = useCallback(() => {
    if (skillId && typeof window.agentAPI?.openSkillDir === 'function') {
      void window.agentAPI.openSkillDir(skillId);
    }
  }, [skillId]);

  if (!skill) return null;

  return (
    <Modal isOpen={skill !== null} onClose={onClose} title={skill.displayName} size="xl">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] text-mac-text-sec font-mono break-all">
          {skill.rootPath}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          leftIcon={<FolderOpen size={14} />}
          onClick={openInFinder}
        >
          在 Finder 中显示
        </Button>
      </div>
      <div className="flex gap-3 h-[60vh] min-h-[360px]">
        <div className="w-[220px] shrink-0 overflow-auto rounded-[8px] border border-mac-border bg-mac-control/30 p-2">
          {tree ? (
            <TreeView node={tree} selected={selected} onSelect={setSelected} depth={0} />
          ) : (
            <p className="text-[12px] text-mac-text-sec px-1 py-2">读取目录失败</p>
          )}
        </div>
        <div className="flex-1 overflow-auto rounded-[8px] border border-mac-border bg-mac-elevated p-3">
          <FileContent path={selected} content={content} loading={loadingFile} />
        </div>
      </div>
    </Modal>
  );
}

function TreeView({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: SkillTreeNode;
  selected: string | null;
  onSelect: (relPath: string) => void;
  depth: number;
}) {
  // 根节点不显示自身，只渲染子项。
  if (node.isDir && node.relPath === '') {
    return (
      <ul className="list-none m-0 p-0">
        {(node.children ?? []).map((c) => (
          <TreeNode key={c.relPath} node={c} selected={selected} onSelect={onSelect} depth={depth} />
        ))}
      </ul>
    );
  }
  return <TreeNode node={node} selected={selected} onSelect={onSelect} depth={depth} />;
}

function TreeNode({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: SkillTreeNode;
  selected: string | null;
  onSelect: (relPath: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 4 + depth * 12 };

  if (node.isDir) {
    return (
      <li className="list-none">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          fullWidth
          onClick={() => setOpen((v) => !v)}
          style={pad}
          className="h-auto justify-start gap-1 rounded-[5px] py-1 pr-1 text-left text-[12px] text-foreground"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? <FolderOpen size={13} /> : <FolderClosed size={13} />}
          <span className="truncate">{node.name}</span>
        </Button>
        {open ? (
          <ul className="list-none m-0 p-0">
            {(node.children ?? []).map((c) => (
              <TreeNode
                key={c.relPath}
                node={c}
                selected={selected}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const active = selected === node.relPath;
  return (
    <li className="list-none">
      <Button
        type="button"
        variant={active ? 'accent' : 'ghost'}
        size="xs"
        fullWidth
        onClick={() => onSelect(node.relPath)}
        style={pad}
        className="h-auto justify-start gap-1 rounded-[5px] py-1 pr-1 text-left text-[12px]"
      >
        <span className="w-3 shrink-0" />
        <File size={13} />
        <span className="truncate">{node.name}</span>
      </Button>
    </li>
  );
}

function FileContent({
  path,
  content,
  loading,
}: {
  path: string | null;
  content: SkillFileContent | { error: string } | null;
  loading: boolean;
}) {
  if (!path) {
    return <p className="text-[13px] text-mac-text-sec">选择左侧文件查看内容。</p>;
  }
  if (loading || !content) {
    return <p className="text-[13px] text-mac-text-sec">加载中…</p>;
  }
  if ('error' in content) {
    return <p className="text-[13px] text-mac-red">读取失败：{content.error}</p>;
  }
  if (content.binary) {
    return (
      <p className="text-[13px] text-mac-text-sec">
        二进制 / 图片文件，不可预览（{formatSize(content.size)}）。
      </p>
    );
  }
  const isMarkdown = /\.mdx?$/i.test(path);
  return (
    <div>
      {content.truncated ? (
        <p className="text-[12px] text-mac-text-sec mb-2">
          文件较大，仅展示前 256KB。
        </p>
      ) : null}
      {isMarkdown ? (
        <div data-color-mode="dark">
          <Suspense fallback={<p className="text-[13px] text-mac-text-sec">渲染中…</p>}>
            <Markdown source={content.text ?? ''} {...buildSafeMarkdownPreviewOptions()} />
          </Suspense>
        </div>
      ) : (
        <pre className="text-[12px] leading-relaxed text-foreground font-mono whitespace-pre-wrap break-words m-0">
          {content.text}
        </pre>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
