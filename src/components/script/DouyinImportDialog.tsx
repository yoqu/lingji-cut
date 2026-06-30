import { FileAudio, FileVideo, FolderSearch, Link2, Loader2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Field,
  Input,
  Progress,
  Textarea,
} from '../../ui';
import { PillGroup } from '../../ui/patterns';
import type {
  VideoImportProgress,
  VideoImportResult,
  VideoImportSourceInput,
} from '../../lib/video-import-types';
import type { AutoWorkflowParams } from '../../store/ai';
import {
  AutoModeSection,
  type AutoModeModelBinding,
  type AutoModeOption,
} from './AutoModeSection';
import { getLastProjectParentDir, setLastProjectParentDir } from '../../lib/project-dir-memory';
import { getFileNameFromPath, toFileSrc } from '../../lib/utils';
import { getDroppedFilePath } from '../../lib/import-files';
import styles from './DouyinImportDialog.module.css';

type ImportMode = 'douyin' | 'local_video' | 'local_audio';

const LOCAL_MEDIA_EXTENSIONS: Record<'local_video' | 'local_audio', string[]> = {
  local_video: ['.mp4', '.mov', '.webm', '.m4v'],
  local_audio: ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus'],
};

const IMPORT_MODE_ITEMS = [
  { value: 'douyin', label: '抖音链接' },
  { value: 'local_video', label: '本地视频' },
  { value: 'local_audio', label: '本地音频' },
] satisfies Array<{ value: ImportMode; label: string }>;

/** create 模式下「一键成稿」配置所需的下拉选项与默认值（由调用方按 AISettings 派生） */
export interface AutoModeOptionsBundle {
  roles: AutoModeOption[];
  voices: AutoModeOption[];
  models: AutoModeOption[];
  defaults: AutoWorkflowParams;
  defaultModelBinding: AutoModeModelBinding | null;
}

interface DouyinImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 'import'（默认）：在已有项目内导入，显示进度条，提交走 onSubmit。
   * 'create'：从管理页进入，先创建项目（工程名/目录/一键成稿），提交走 onCreate。
   */
  mode?: 'create' | 'import';

  // ── import 模式 ──
  busy?: boolean;
  progress?: VideoImportProgress | null;
  lastResult?: VideoImportResult | null;
  errorMessage?: string | null;
  onSubmit?: (source: VideoImportSourceInput) => Promise<void>;
  onOpenPreview?: () => void;

  // ── create 模式 ──
  defaultParentDir?: string;
  autoModeOptions?: AutoModeOptionsBundle;
  onCreate?: (
    parentDir: string,
    title: string,
    source: VideoImportSourceInput,
    autoMode: boolean,
    autoParams: AutoWorkflowParams,
    modelBinding: AutoModeModelBinding | null,
  ) => Promise<void>;
}

export function DouyinImportDialog({
  open,
  onOpenChange,
  mode = 'import',
  busy = false,
  progress = null,
  lastResult = null,
  errorMessage = null,
  onSubmit,
  onOpenPreview,
  defaultParentDir = '',
  autoModeOptions,
  onCreate,
}: DouyinImportDialogProps) {
  const isCreate = mode === 'create';
  const [importMode, setImportMode] = useState<ImportMode>('douyin');
  const [url, setUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [localFileError, setLocalFileError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // ── create 模式专用状态 ──
  const [title, setTitle] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const [autoParams, setAutoParams] = useState<AutoWorkflowParams>(
    autoModeOptions?.defaults ?? { templateId: 'news-broadcast', roleId: 'none', voiceId: '' },
  );
  const [modelBinding, setModelBinding] = useState<AutoModeModelBinding | null>(
    autoModeOptions?.defaultModelBinding ?? null,
  );

  const busyState = isCreate ? creating || resolving : busy;
  const hasCompletedImport = Boolean(lastResult) && !busy;
  const localMode = importMode === 'local_video' || importMode === 'local_audio' ? importMode : null;
  const acceptedExtensions = useMemo(
    () => (localMode ? LOCAL_MEDIA_EXTENSIONS[localMode] : []),
    [localMode],
  );
  const sourceReady = importMode === 'douyin' ? Boolean(title.trim()) : Boolean(filePath.trim());
  const canSubmit = (importMode === 'douyin' ? Boolean(url.trim()) : Boolean(filePath.trim())) && !busy;
  const canCreate = Boolean(title.trim()) && Boolean(parentDir) && sourceReady && !busyState;
  const isAudioOnlyResult = lastResult?.sourceType === 'local_audio';
  const lastSourceLabel = lastResult?.sourceType === 'local_audio' ? '音频 ID' : '视频 ID';

  // 弹窗关闭：复位全部输入；create 模式同时复位创建态并回灌默认目录/成稿参数。
  useEffect(() => {
    if (open) {
      if (isCreate) {
        setParentDir(getLastProjectParentDir() || defaultParentDir);
        setAutoParams(autoModeOptions?.defaults ?? { templateId: 'news-broadcast', roleId: 'none', voiceId: '' });
        setModelBinding(autoModeOptions?.defaultModelBinding ?? null);
      }
      return;
    }
    setUrl('');
    setFilePath('');
    setLocalFileError(null);
    setDragActive(false);
    setImportMode('douyin');
    setTitle('');
    setResolving(false);
    setCreating(false);
    setCreateError(null);
    setAutoMode(false);
  }, [open, isCreate, defaultParentDir, autoModeOptions]);

  const resetSourceForMode = () => {
    setFilePath('');
    setLocalFileError(null);
    setDragActive(false);
    if (isCreate) setTitle('');
  };

  const validateLocalFilePath = (nextPath: string): string | null => {
    if (!localMode) return null;
    const lower = nextPath.toLowerCase();
    if (acceptedExtensions.some((extension) => lower.endsWith(extension))) return null;
    return `请导入 ${acceptedExtensions.join(' / ')} 文件。`;
  };

  const applyLocalFilePath = (nextPath: string) => {
    const error = validateLocalFilePath(nextPath);
    setLocalFileError(error);
    if (error) return;
    setFilePath(nextPath);
    // create 模式：用文件名（去扩展名）推导工程名，未手填时自动填充。
    if (isCreate) {
      const stem = getFileNameFromPath(nextPath).replace(/\.[^.]+$/, '').trim();
      setTitle((prev) => (prev.trim() ? prev : stem || '本地媒体'));
    }
  };

  const handleSelectLocalFile = async () => {
    if (!localMode) return;
    const selected = await window.electronAPI.selectMediaFile(
      importMode === 'local_video' ? 'video' : 'audio',
    );
    if (selected) applyLocalFilePath(selected);
  };

  const handleLocalDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!localMode || busyState || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };

  const handleLocalDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDragActive(false);
  };

  const handleLocalDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!localMode || busyState) return;
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    if (!file) return;
    const nextPath = getDroppedFilePath(file, window.electronAPI.getPathForFile);
    if (!nextPath) {
      setLocalFileError('无法读取拖入文件路径，请改用选择文件。');
      return;
    }
    applyLocalFilePath(nextPath);
  };

  // create 模式：解析抖音链接，提取标题填入工程名。
  const handleResolveDouyin = async () => {
    if (!url.trim()) return;
    setResolving(true);
    setCreateError(null);
    try {
      const { title: resolved } = await window.electronAPI.resolveDouyinUrl(url.trim());
      setTitle(resolved);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '解析失败，请检查链接是否有效');
    } finally {
      setResolving(false);
    }
  };

  const handleSelectParentDir = async () => {
    const dir = await window.electronAPI.selectProjectDirectory();
    if (!dir) return;
    setParentDir(dir);
    setLastProjectParentDir(dir);
  };

  const buildSource = (): VideoImportSourceInput | null => {
    if (importMode === 'douyin') return { sourceType: 'douyin', url: url.trim() };
    const error = validateLocalFilePath(filePath.trim());
    if (error) {
      setLocalFileError(error);
      return null;
    }
    return { sourceType: importMode, filePath: filePath.trim() };
  };

  // import 模式提交：直接在当前项目内导入。
  const handleSubmit = () => {
    const source = buildSource();
    if (source) void onSubmit?.(source);
  };

  // create 模式提交：创建项目并触发导入。
  const handleCreate = async () => {
    if (!canCreate) return;
    const source = buildSource();
    if (!source) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate?.(
        parentDir,
        title.trim(),
        source,
        autoMode,
        autoParams,
        autoMode ? modelBinding : null,
      );
      onOpenChange(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>导入媒体</DialogTitle>
          <DialogDescription>
            支持抖音链接、本地视频和本地音频，系统会自动转换音频并转录为项目的 `original.md`。
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className={styles.shell}>
            <PillGroup
              fullWidth
              wrap={false}
              size="sm"
              className={styles.sourceTabs}
              items={IMPORT_MODE_ITEMS.map((item) => ({ ...item, disabled: busyState }))}
              value={importMode}
              onChange={(value) => {
                setImportMode(value);
                resetSourceForMode();
              }}
            />

            {importMode === 'douyin' ? (
              <Field label="视频链接">
                <div className={styles.linkBox}>
                  <Textarea
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://v.douyin.com/..."
                    rows={isCreate ? 3 : 4}
                  />
                  {isCreate ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleResolveDouyin}
                      disabled={!url.trim() || busyState}
                      leftIcon={resolving ? <Loader2 size={13} className={styles.spin} /> : <Link2 size={13} />}
                    >
                      {resolving ? '解析中…' : '解析链接'}
                    </Button>
                  ) : null}
                </div>
              </Field>
            ) : (
              <Field label={importMode === 'local_video' ? '视频文件' : '音频文件'}>
                <div
                  className={`${styles.filePicker} ${dragActive ? styles.filePickerActive : ''}`}
                  onDragEnter={handleLocalDragOver}
                  onDragOver={handleLocalDragOver}
                  onDragLeave={handleLocalDragLeave}
                  onDrop={handleLocalDrop}
                >
                  <div className={`${styles.fileIcon} ${filePath ? styles.fileIconFilled : ''}`}>
                    {importMode === 'local_video' ? <FileVideo size={17} /> : <FileAudio size={17} />}
                  </div>
                  <div className={styles.fileInfo}>
                    <div className={styles.fileName}>
                      {filePath
                        ? getFileNameFromPath(filePath)
                        : dragActive
                          ? '松开导入文件'
                          : importMode === 'local_video'
                            ? '选择或拖入视频文件'
                            : '选择或拖入音频文件'}
                    </div>
                    <div className={styles.fileHint}>
                      {filePath || acceptedExtensions.join(' / ')}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSelectLocalFile}
                    disabled={busyState}
                    leftIcon={<Upload size={13} />}
                  >
                    {filePath ? '更换' : '选择'}
                  </Button>
                </div>
                {localFileError ? <div className={styles.errorText}>{localFileError}</div> : null}
              </Field>
            )}

            {/* create 模式：工程名 + 存放目录 + 一键成稿 */}
            {isCreate ? (
              <>
                <Field label="工程名">
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={importMode === 'douyin' ? '解析链接后自动填入，可修改' : '选择文件后自动填入，可修改'}
                  />
                </Field>
                <Field label="存放目录">
                  <button
                    type="button"
                    className={styles.dirPicker}
                    onClick={handleSelectParentDir}
                    disabled={busyState}
                  >
                    <FolderSearch size={16} strokeWidth={1.6} />
                    <span className={styles.dirPickerText}>{parentDir || '点击选择项目存放目录'}</span>
                    <span className={styles.dirPickerAction}>{parentDir ? '更换' : '选择'}</span>
                  </button>
                </Field>
                {sourceReady && autoModeOptions ? (
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
                ) : null}
              </>
            ) : null}

            {/* import 模式：导入进度 */}
            {!isCreate && progress ? (
              <div className={styles.progressBox}>
                <div className={styles.progressHeader}>
                  <span className={styles.progressLabel}>{progress.stepLabel}</span>
                  <span className={styles.progressPercent}>{progress.progress}%</span>
                </div>
                <Progress
                  value={progress.progress}
                  size="sm"
                  variant={progress.status === 'done' ? 'success' : 'default'}
                />
                <div className={styles.statusText}>
                  {progress.status === 'downloading' && '正在准备媒体…'}
                  {progress.status === 'extracting_audio' && '正在提取音频…'}
                  {progress.status === 'transcribing' && '正在转录字幕…'}
                  {progress.status === 'syncing' && '正在同步到项目…'}
                  {progress.status === 'done' && '导入完成'}
                  {progress.status === 'error' && '导入失败'}
                </div>
              </div>
            ) : null}

            {!isCreate && lastResult ? (
              <div className={styles.resultBox}>
                <div className={styles.resultHeader}>
                  <div>
                    <p className={styles.resultTitle}>最近一次导入：{lastResult.title}</p>
                    <div className={styles.resultSubtitle}>已写入 {lastResult.transcriptPath}</div>
                  </div>
                </div>

                {isAudioOnlyResult ? (
                  <audio
                    className={styles.audioPreview}
                    controls
                    preload="metadata"
                    src={toFileSrc(lastResult.audioPath)}
                  />
                ) : (
                  <div className={styles.previewFrame}>
                    <video
                      className={styles.videoPreview}
                      controls
                      preload="metadata"
                      src={toFileSrc(lastResult.videoPath)}
                    />
                  </div>
                )}

                <div className={styles.metaGrid}>
                  <span className={styles.metaLabel}>{lastSourceLabel}</span>
                  <span className={styles.metaValue}>{lastResult.videoId}</span>
                  <span className={styles.metaLabel}>来源</span>
                  <span className={styles.metaValue}>
                    {lastResult.sourceUrl ?? lastResult.sourcePath ?? '本地媒体'}
                  </span>
                  <span className={styles.metaLabel}>预览文件</span>
                  <span className={styles.metaValue}>
                    {getFileNameFromPath(lastResult.previewMetadataPath)}
                  </span>
                </div>

                <div className={styles.resultActions}>
                  <Button
                    variant="ghost"
                    onClick={() => window.electronAPI.showItemInFolder(lastResult.videoPath)}
                    leftIcon={<Link2 size={13} />}
                  >
                    查看目录
                  </Button>
                  <Button variant="secondary" onClick={() => onOpenPreview?.()} disabled={!onOpenPreview}>
                    打开预览
                  </Button>
                </div>
              </div>
            ) : null}

            {(isCreate ? createError : errorMessage) ? (
              <Alert variant="error">{isCreate ? createError : errorMessage}</Alert>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busyState}>
            {!isCreate && hasCompletedImport ? '立即关闭' : '取消'}
          </Button>
          {isCreate ? (
            <Button variant="secondary" onClick={handleCreate} disabled={!canCreate}>
              {creating ? '创建中…' : '开始导入'}
            </Button>
          ) : hasCompletedImport && !canSubmit ? (
            <Button variant="secondary" onClick={() => onOpenPreview?.()} disabled={!onOpenPreview}>
              打开预览
            </Button>
          ) : (
            <Button variant="secondary" onClick={handleSubmit} disabled={!canSubmit}>
              {busy ? '导入中…' : hasCompletedImport ? '再次导入' : '开始导入'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
