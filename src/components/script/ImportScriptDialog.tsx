import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  FolderSearch,
  Link2,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Textarea,
} from '../../ui';
import { PillGroup } from '../../ui/patterns';
import { getFileNameFromPath } from '../../lib/utils';
import {
  AutoModeSection,
  type AutoModeModelBinding,
  type AutoModeOption,
} from './AutoModeSection';
import type { AutoWorkflowParams } from '../../store/ai';
import type { WechatArticleMeta } from '../../lib/article-import-types';
import styles from './ImportScriptDialog.module.css';

/** 抓取成功后随确认回调传出的公众号来源信息，落地阶段据此下载图片 */
export interface ImportWechatArticleSource {
  articleId: string;
  meta: WechatArticleMeta;
}

export type ImportSourceTab = 'text' | 'wechat';

const SOURCE_TAB_ITEMS = [
  { value: 'text', label: '粘贴 / 文件' },
  { value: 'wechat', label: '公众号文章' },
] satisfies Array<{ value: ImportSourceTab; label: string }>;

export interface ImportDialogSeedInput {
  defaults: AutoWorkflowParams;
  defaultModelBinding: AutoModeModelBinding | null;
  initialContent?: string;
  initialProjectName?: string;
  initialParentDir?: string | null;
  initialAutoMode?: boolean;
  templateIdOverride?: string;
}

export interface ImportDialogSeed {
  content: string;
  projectName: string;
  parentDir: string | null;
  autoMode: boolean;
  autoParams: AutoWorkflowParams;
  modelBinding: AutoModeModelBinding | null;
}

/**
 * 计算「导入文稿」弹窗打开时的初始状态种子。
 * 纯函数（无 hooks），便于在 node 测试环境直接断言；模板覆盖逻辑集中于此。
 */
export function computeImportDialogSeed(input: ImportDialogSeedInput): ImportDialogSeed {
  return {
    content: input.initialContent ?? '',
    projectName: input.initialProjectName ?? '',
    parentDir: input.initialParentDir ?? null,
    autoMode: input.initialAutoMode ?? false,
    autoParams: {
      ...input.defaults,
      templateId: input.templateIdOverride ?? input.defaults.templateId,
    },
    modelBinding: input.defaultModelBinding,
  };
}

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.html', '.htm'] as const;
const ALLOWED_LABEL = '.md / .txt / .html';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB 上限，避免误拖音视频

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface ImportScriptDialogProps {
  open: boolean;
  busy: boolean;
  errorMessage: string | null;
  onOpenChange: (open: boolean) => void;
  /** 确认导入：传入父目录、项目名、原稿内容、是否一键成稿、自动模式参数、写稿模型绑定、公众号来源（非公众号导入为 null） */
  onConfirm: (
    parentDir: string,
    projectName: string,
    content: string,
    autoMode: boolean,
    autoParams: AutoWorkflowParams,
    modelBinding: AutoModeModelBinding | null,
    wechatArticle: ImportWechatArticleSource | null,
  ) => Promise<void> | void;
  /** 一键成稿下拉选项与默认值（由父组件提供） */
  autoModeOptions: {
    roles: AutoModeOption[];
    voices: AutoModeOption[];
    models: AutoModeOption[];
    defaults: AutoWorkflowParams;
    defaultModelBinding: AutoModeModelBinding | null;
  };
  /** 打开时预填文稿内容（如声呐转录稿）；缺省为空 */
  initialContent?: string;
  /** 打开时预填项目名；缺省为空 */
  initialProjectName?: string;
  /** 打开时预填存放目录；缺省为 null */
  initialParentDir?: string | null;
  /** 一键成稿开关初值；缺省 false */
  initialAutoMode?: boolean;
  /** 写稿模板覆盖（如待创作箱用 'rewrite-remix' 二创转述）；模板在 UI 上不暴露，仅落到一键参数 */
  templateIdOverride?: string;
  /** 打开时激活的来源 Tab（欢迎页「公众号导入」入口传 'wechat'）；缺省 'text' */
  initialSourceTab?: ImportSourceTab;
}

export function ImportScriptDialog({
  open,
  busy,
  errorMessage,
  onOpenChange,
  onConfirm,
  autoModeOptions,
  initialContent,
  initialProjectName,
  initialParentDir,
  initialAutoMode,
  templateIdOverride,
  initialSourceTab,
}: ImportScriptDialogProps) {
  const seed0 = computeImportDialogSeed({
    defaults: autoModeOptions.defaults,
    defaultModelBinding: autoModeOptions.defaultModelBinding,
    initialContent,
    initialProjectName,
    initialParentDir,
    initialAutoMode,
    templateIdOverride,
  });
  const [content, setContent] = useState(seed0.content);
  const [projectName, setProjectName] = useState(seed0.projectName);
  const [parentDir, setParentDir] = useState<string | null>(seed0.parentDir);
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<ImportSourceTab>(initialSourceTab ?? 'text');
  const [wechatUrl, setWechatUrl] = useState('');
  const [fetchingWechat, setFetchingWechat] = useState(false);
  const [wechatArticle, setWechatArticle] = useState<ImportWechatArticleSource | null>(null);
  const [autoMode, setAutoMode] = useState(seed0.autoMode);
  const [autoParams, setAutoParams] = useState<AutoWorkflowParams>(seed0.autoParams);
  const [modelBinding, setModelBinding] = useState<AutoModeModelBinding | null>(seed0.modelBinding);
  const dragDepthRef = useRef(0);
  const prevOpenRef = useRef(false);

  // 弹窗每次「打开」时按当前 props 播种，保证下一次复用（普通导入 / 待创作箱预填）状态干净。
  // 用 prevOpenRef 仅在 false→true 跳变时播种，避免 props 变化时清空用户正在编辑的内容。
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const seed = computeImportDialogSeed({
        defaults: autoModeOptions.defaults,
        defaultModelBinding: autoModeOptions.defaultModelBinding,
        initialContent,
        initialProjectName,
        initialParentDir,
        initialAutoMode,
        templateIdOverride,
      });
      setContent(seed.content);
      setProjectName(seed.projectName);
      setParentDir(seed.parentDir);
      setSourceFileName(null);
      setIsDragging(false);
      setReadingFile(false);
      setLocalError(null);
      setSourceTab(initialSourceTab ?? 'text');
      setWechatUrl('');
      setFetchingWechat(false);
      setWechatArticle(null);
      setAutoMode(seed.autoMode);
      setAutoParams(seed.autoParams);
      setModelBinding(seed.modelBinding);
      dragDepthRef.current = 0;
    }
    prevOpenRef.current = open;
  }, [
    open,
    autoModeOptions.defaults,
    autoModeOptions.defaultModelBinding,
    initialContent,
    initialProjectName,
    initialParentDir,
    initialAutoMode,
    templateIdOverride,
    initialSourceTab,
  ]);

  const trimmedName = projectName.trim();
  const canConfirm = useMemo(
    () => Boolean(content.trim() && trimmedName && parentDir && !busy && !readingFile),
    [content, trimmedName, parentDir, busy, readingFile],
  );

  const applyFile = useCallback(async (file: File) => {
    if (!hasAllowedExtension(file.name)) {
      setLocalError(`仅支持 ${ALLOWED_LABEL} 文件`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 5 MB`);
      return;
    }
    setReadingFile(true);
    setLocalError(null);
    try {
      const text = await file.text();
      setContent(text);
      setSourceFileName(file.name);
      setWechatArticle(null);
      // 仅当用户尚未自定义项目名时，用文件名预填
      setProjectName((prev) => (prev.trim() ? prev : stripExtension(file.name)));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '读取文件失败');
    } finally {
      setReadingFile(false);
    }
  }, []);

  const handleSelectFileClick = useCallback(async () => {
    setLocalError(null);
    const result = await window.electronAPI.selectTextFile();
    if (!result) return;
    if (!hasAllowedExtension(result.path)) {
      setLocalError(`仅支持 ${ALLOWED_LABEL} 文件`);
      return;
    }
    setContent(result.content);
    const name = getFileNameFromPath(result.path);
    setSourceFileName(name);
    setWechatArticle(null);
    setProjectName((prev) => (prev.trim() ? prev : stripExtension(name)));
  }, []);

  const handleFetchWechat = useCallback(async () => {
    const url = wechatUrl.trim();
    if (!url) return;
    setFetchingWechat(true);
    setLocalError(null);
    try {
      const result = await window.electronAPI.fetchWechatArticle(url);
      setContent(result.markdown);
      setSourceFileName(
        `公众号 · ${result.meta.title}${result.imageCount ? `（${result.imageCount} 张配图）` : ''}`,
      );
      setWechatArticle({ articleId: result.articleId, meta: result.meta });
      setProjectName((prev) => (prev.trim() ? prev : result.meta.title));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '公众号文章抓取失败');
    } finally {
      setFetchingWechat(false);
    }
  }, [wechatUrl]);

  const handleSelectDir = useCallback(async () => {
    const dir = await window.electronAPI.selectProjectDirectory();
    if (dir) setParentDir(dir);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void applyFile(file);
    },
    [applyFile],
  );

  const handleClearSource = useCallback(() => {
    setContent('');
    setSourceFileName(null);
    setWechatArticle(null);
    setLocalError(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!canConfirm || !parentDir) return;
    void onConfirm(
      parentDir,
      trimmedName,
      content,
      autoMode,
      autoParams,
      modelBinding,
      wechatArticle,
    );
  }, [
    canConfirm,
    parentDir,
    trimmedName,
    content,
    autoMode,
    autoParams,
    modelBinding,
    wechatArticle,
    onConfirm,
  ]);

  const previewPath = parentDir && trimmedName ? `${parentDir}/${trimmedName}` : null;
  const displayedError = errorMessage ?? localError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>导入文稿</DialogTitle>
          <DialogDescription>
            粘贴原稿、拖拽文件、选择 .md / .txt / .html 文件，或抓取微信公众号文章；导入后可启用自动剪辑，或进入工作台手动生成口播稿
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {/* 文稿来源切换：粘贴/文件 或 公众号文章链接 */}
          <PillGroup
            fullWidth
            wrap={false}
            size="sm"
            items={SOURCE_TAB_ITEMS.map((item) => ({ ...item, disabled: busy || fetchingWechat }))}
            value={sourceTab}
            onChange={setSourceTab}
          />

          {sourceTab === 'wechat' && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              {/* 公众号文章抓取：粘贴链接 → 主进程抓取转 Markdown 回填，图片在创建项目时本地化 */}
              <Field
                label="公众号文章链接"
                hint="粘贴 mp.weixin.qq.com 链接抓取全文；正文图片会在创建项目时自动下载到项目内"
              >
                <div className={styles.wechatRow}>
                  <Input
                    type="text"
                    value={wechatUrl}
                    onChange={(e) => setWechatUrl(e.target.value)}
                    placeholder="https://mp.weixin.qq.com/s/..."
                    leftIcon={<Link2 size={16} strokeWidth={1.5} />}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleFetchWechat();
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={() => void handleFetchWechat()}
                    disabled={!wechatUrl.trim() || fetchingWechat || busy}
                  >
                    {fetchingWechat ? (
                      <>
                        <Loader2 size={14} className={styles.spinIcon} />
                        抓取中
                      </>
                    ) : (
                      '抓取'
                    )}
                  </Button>
                </div>
              </Field>
            </div>
          )}

          {/* 文稿内容：text 来源支持拖拽/选文件；wechat 来源作为抓取结果预览（可编辑） */}
          <div style={{ marginTop: 'var(--space-6)' }}>
            <Field label={sourceTab === 'wechat' ? '文稿内容（抓取后可编辑）' : '文稿内容'}>
              <div
                className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
                onDragEnter={sourceTab === 'text' ? handleDragEnter : undefined}
                onDragLeave={sourceTab === 'text' ? handleDragLeave : undefined}
                onDragOver={sourceTab === 'text' ? handleDragOver : undefined}
                onDrop={sourceTab === 'text' ? handleDrop : undefined}
              >
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={
                    sourceTab === 'wechat'
                      ? '抓取公众号文章后，转换出的 Markdown 会显示在这里，可直接编辑'
                      : '在此粘贴或输入原稿内容，也可以拖拽 .md / .txt / .html 文件到这里'
                  }
                  rows={8}
                  resize="vertical"
                />
                {isDragging && (
                  <div className={styles.dropOverlay}>
                    <Upload size={28} strokeWidth={1.5} />
                    <span>松开以载入文件</span>
                  </div>
                )}
              </div>

              <div className={styles.sourceActions}>
                {sourceTab === 'text' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleSelectFileClick()}
                    disabled={readingFile}
                  >
                    {readingFile ? (
                      <>
                        <Loader2 size={14} className={styles.spinIcon} />
                        读取中
                      </>
                    ) : (
                      <>
                        <FileText size={14} strokeWidth={1.7} />
                        选择文件…
                      </>
                    )}
                  </Button>
                )}
                {sourceFileName && (
                  <span className={styles.sourceTag}>
                    <CheckCircle2 size={13} strokeWidth={2} className={styles.sourceTagIcon} />
                    <span className={styles.sourceTagName}>{sourceFileName}</span>
                    <button
                      type="button"
                      className={styles.sourceTagClear}
                      onClick={handleClearSource}
                      aria-label="清除已加载文件"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </span>
                )}
              </div>
            </Field>
          </div>

          {/* 项目名 */}
          <div style={{ marginTop: 'var(--space-6)' }}>
            <Field label="项目名称" hint="将作为项目文件夹名">
              <Input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="例如：我的第一期播客"
                leftIcon={<FolderOpen size={16} strokeWidth={1.5} />}
              />
            </Field>
          </div>

          {/* 父目录 */}
          <div style={{ marginTop: 'var(--space-6)' }}>
            <Field label="存放目录">
              <button
                type="button"
                className={styles.dirPickerButton}
                onClick={() => void handleSelectDir()}
              >
                <FolderSearch size={20} strokeWidth={1.5} />
                <span className={styles.dirPickerText}>
                  {parentDir ?? '选择项目存放目录'}
                </span>
              </button>
            </Field>
          </div>

          {/* 路径预览 */}
          {previewPath && (
            <div className={styles.projectPath}>
              <FolderOpen size={14} strokeWidth={1.5} />
              <span>项目将创建在：{previewPath}</span>
            </div>
          )}

          {/* 一键成稿（自动写稿、TTS、卡片、封面，跳过审稿） */}
          <div style={{ marginTop: 'var(--space-6)' }}>
            <AutoModeSection
              enabled={autoMode}
              onToggle={setAutoMode}
              params={autoParams}
              onChangeParams={setAutoParams}
              roleOptions={autoModeOptions.roles}
              voiceOptions={autoModeOptions.voices}
              modelOptions={autoModeOptions.models}
              modelBinding={modelBinding}
              onChangeModelBinding={setModelBinding}
            />
          </div>

          {/* 错误提示 */}
          {displayedError && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Alert variant="error">{displayedError}</Alert>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={busy}>取消</Button>
          </DialogClose>
          <Button variant="primary" disabled={!canConfirm} onClick={handleConfirm}>
            {busy ? '创建中…' : '创建项目并开始创作'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
