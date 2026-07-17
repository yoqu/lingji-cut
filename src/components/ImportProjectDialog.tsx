import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderSearch, Loader2, RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui';
import type {
  DetectedFileKind,
  ImportProjectResult,
  ImportProjectScanResult,
  ImportProjectScenario,
} from '../lib/project-import-types';

export interface ImportProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入成功回调；父组件负责 addRecentProject + 页面导航 */
  onImported: (result: ImportProjectResult) => Promise<void> | void;
}

interface ScenarioCopy {
  tag: string;
  description: string;
  variant: 'success' | 'info' | 'warning' | 'error';
}

const SCENARIO_COPY: Record<ImportProjectScenario, ScenarioCopy> = {
  complete: {
    tag: '完整项目',
    description: '检测到 project.json，将读取现有项目数据并修复跨机器路径。',
    variant: 'success',
  },
  mediaOnly: {
    tag: '仅含媒资',
    description: '未找到 project.json，将创建一个空的项目骨架，已有媒资会保留在目录中。',
    variant: 'info',
  },
  unrecognized: {
    tag: '无法识别',
    description: '此目录无法识别为项目。',
    variant: 'error',
  },
};

const FILE_KIND_LABEL: Record<DetectedFileKind, string> = {
  projectJson: 'project.json',
  scriptMd: 'script.md',
  originalMd: 'original.md',
  audioMp3: 'podcast-audio.mp3',
  subtitleSrt: 'podcast-subtitles.srt',
  coverImage: 'covers/',
  aiCard: 'ai-cards/',
  douyinImport: 'imports/douyin/',
  promptOverride: 'configs/prompts/',
  other: '其他',
};

const ASSET_KIND_LABEL = {
  overlayAsset: '时间线素材',
  podcastAudio: '口播音频',
  podcastSubtitle: '口播字幕',
  ttsAsset: '口播素材',
} as const;

function summarizeDetectedFiles(files: ImportProjectScanResult['detectedFiles']): string[] {
  const counts = new Map<DetectedFileKind, number>();
  for (const f of files) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  const ORDER: DetectedFileKind[] = [
    'projectJson',
    'scriptMd',
    'originalMd',
    'audioMp3',
    'subtitleSrt',
    'coverImage',
    'aiCard',
    'douyinImport',
    'promptOverride',
  ];
  const parts: string[] = [];
  for (const kind of ORDER) {
    const n = counts.get(kind);
    if (!n) continue;
    const label = FILE_KIND_LABEL[kind];
    parts.push(n > 1 ? `${label} ×${n}` : label);
  }
  return parts;
}

export function ImportProjectDialog({ open, onOpenChange, onImported }: ImportProjectDialogProps) {
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scan, setScan] = useState<ImportProjectScanResult | null>(null);
  const [acceptMissing, setAcceptMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissingDetails, setShowMissingDetails] = useState(false);

  // 关闭时重置
  useEffect(() => {
    if (!open) {
      setScanning(false);
      setImporting(false);
      setScan(null);
      setAcceptMissing(false);
      setError(null);
      setShowMissingDetails(false);
    }
  }, [open]);

  const runScan = useCallback(async (projectDir: string) => {
    setScanning(true);
    setError(null);
    setScan(null);
    setAcceptMissing(false);
    setShowMissingDetails(false);
    try {
      const result = await window.electronAPI.scanProjectDirectory(projectDir);
      setScan(result);
    } catch (err) {
      setError(`扫描失败：${(err as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  const handleSelectDirectory = useCallback(async () => {
    const dir = await window.electronAPI.selectProjectDirectory();
    if (!dir) return;
    await runScan(dir);
  }, [runScan]);

  const handleReScan = useCallback(async () => {
    if (!scan) return;
    await runScan(scan.projectDir);
  }, [scan, runScan]);

  const canImport =
    scan !== null &&
    scan.scenario !== 'unrecognized' &&
    !importing &&
    !scanning &&
    (scan.assetReferences.missingCount === 0 || acceptMissing);

  const handleImport = useCallback(async () => {
    if (!scan || scan.scenario === 'unrecognized') return;
    setImporting(true);
    setError(null);
    try {
      const response = await window.electronAPI.importProject({
        projectDir: scan.projectDir,
        acceptMissingAssets: acceptMissing,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      await onImported(response.result);
    } catch (err) {
      setError(`导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, [scan, acceptMissing, onImported]);

  const scenarioCopy = scan ? SCENARIO_COPY[scan.scenario] : null;
  const fileSummary = scan ? summarizeDetectedFiles(scan.detectedFiles) : [];
  const { assetReferences } = scan ?? {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>导入项目</DialogTitle>
          <DialogDescription>
            选择从其他电脑复制过来的项目目录，灵机剪影会自动识别并修复失效的素材路径。
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* 阶段 A：未选择目录 */}
          {!scan && !scanning && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-mac-blue/10">
                <FolderSearch className="h-7 w-7 text-mac-blue" />
              </div>
              <p className="text-center text-sm text-mac-text-muted">
                选择一个项目目录开始识别
              </p>
              <Button variant="primary" onClick={handleSelectDirectory}>
                选择项目目录…
              </Button>
              {error && (
                <Alert variant="error" className="mt-2 w-full">
                  {error}
                </Alert>
              )}
            </div>
          )}

          {/* 扫描中 */}
          {scanning && (
            <div className="flex flex-col items-center gap-3 py-10">
              <Loader2 className="h-6 w-6 animate-spin text-mac-blue" />
              <p className="text-sm text-mac-text-muted">正在识别项目目录...</p>
            </div>
          )}

          {/* 阶段 B：已扫描完成 */}
          {scan && !scanning && (
            <div className="flex flex-col gap-4">
              {/* 项目路径 */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-mac-text-muted">项目路径</div>
                  <div className="truncate text-sm" title={scan.projectDir}>
                    {scan.projectDir}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<RefreshCw />}
                  onClick={handleReScan}
                  disabled={importing}
                >
                  重新扫描
                </Button>
              </div>

              {/* 场景标签 */}
              {scenarioCopy && (
                <Alert variant={scenarioCopy.variant}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <strong>识别结果：{scenarioCopy.tag}</strong>
                      </div>
                      <div className="text-xs">
                        {scan.blockReason ?? scenarioCopy.description}
                      </div>
                    </div>
                  </div>
                </Alert>
              )}

              {/* 基础统计 */}
              {scan.scenario !== 'unrecognized' && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-mac-border p-3">
                    <div className="text-xs text-mac-text-muted">时间线片段</div>
                    <div className="mt-1 text-lg font-medium">{scan.timelineItemCount}</div>
                  </div>
                  <div className="rounded-md border border-mac-border p-3">
                    <div className="text-xs text-mac-text-muted">封面候选</div>
                    <div className="mt-1 text-lg font-medium">{scan.coverCandidateCount}</div>
                  </div>
                </div>
              )}

              {/* 素材路径统计 */}
              {scan.scenario !== 'unrecognized' && assetReferences && assetReferences.totalReferences > 0 && (
                <div className="rounded-md border border-mac-border p-3">
                  <div className="mb-2 text-xs font-medium text-mac-text-muted">
                    素材路径（共 {assetReferences.totalReferences} 个引用）
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">
                      <CheckCircle2 className="mr-1 h-3 w-3 text-mac-green" />
                      原位可用 {assetReferences.intactCount}
                    </Badge>
                    {assetReferences.fixableCount > 0 && (
                      <Badge variant="outline">
                        <RefreshCw className="mr-1 h-3 w-3 text-mac-blue" />
                        可自动修复 {assetReferences.fixableCount}
                      </Badge>
                    )}
                    {assetReferences.missingCount > 0 && (
                      <Badge variant="outline">
                        <AlertTriangle className="mr-1 h-3 w-3 text-mac-red" />
                        缺失 {assetReferences.missingCount}
                      </Badge>
                    )}
                  </div>

                  {assetReferences.missingCount > 0 && (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="text-xs text-mac-blue hover:underline"
                        onClick={() => setShowMissingDetails((v) => !v)}
                      >
                        {showMissingDetails ? '收起详情' : '查看缺失详情'}
                      </button>
                      {showMissingDetails && (
                        <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-mac-border bg-mac-control/30 p-2 text-xs">
                          {assetReferences.missingItems.map((item, idx) => (
                            <li key={`${item.originalPath}-${idx}`} className="truncate py-0.5" title={item.originalPath}>
                              <span className="mr-1 text-mac-text-muted">
                                [{ASSET_KIND_LABEL[item.kind]}]
                              </span>
                              {item.basename}
                              <span className="ml-1 text-mac-text-muted">← {item.originalPath}</span>
                            </li>
                          ))}
                          {assetReferences.missingCount > assetReferences.missingItems.length && (
                            <li className="py-0.5 text-mac-text-muted">
                              …另有 {assetReferences.missingCount - assetReferences.missingItems.length} 条未展示
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 其他检测到的文件 */}
              {fileSummary.length > 0 && (
                <div className="rounded-md border border-mac-border p-3">
                  <div className="mb-2 text-xs font-medium text-mac-text-muted">检测到的文件</div>
                  <div className="flex flex-wrap gap-1">
                    {fileSummary.map((label) => (
                      <Badge key={label} variant="secondary" className="text-[10px]">
                        {label}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* 允许缺失勾选 */}
              {scan.scenario !== 'unrecognized' &&
                assetReferences &&
                assetReferences.missingCount > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={acceptMissing}
                      onChange={setAcceptMissing}
                      disabled={importing}
                    />
                    <span>
                      允许缺失 {assetReferences.missingCount} 个素材继续导入（缺失素材对应的时间线片段在播放时会报错）
                    </span>
                  </label>
                )}

              {/* S4 阻断 */}
              {scan.scenario === 'unrecognized' && (
                <p className="text-xs text-mac-text-muted">
                  如果这是一个新项目目录，请使用「新建工程」。
                </p>
              )}

              {/* 错误 */}
              {error && (
                <Alert variant="error">{error}</Alert>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!canImport}
            loading={importing}
            loadingText="正在导入..."
          >
            开始导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
