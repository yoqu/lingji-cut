import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  Box,
  CheckCircle2,
  CircleOff,
  FileCheck2,
  FolderCheck,
  Image,
  Music,
  Pipette,
  RotateCcw,
  Scissors,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { Button, ColorField, SearchInput } from '../ui';
import { formatTime, toFileSrc } from '../lib/utils';
import type {
  AssetGenerationRequest,
  AssetKind,
  AssetLibraryFile,
  AssetLibraryState,
  AssetRecord,
  AssetUpdatePatch,
  ProjectAssetHealth,
  ProjectAssetManifest,
} from '../types/assets';
import styles from './AssetCenter.module.css';
import { useAIStore } from '../store/ai';
import { TimelineAudioWaveform } from '../components/TimelineAudioWaveform';
import { AudioAssetMetadataEditor } from '../components/assets/AudioAssetMetadataEditor';

type SourceKey = 'global' | 'project' | 'pending';
type TypeFilter = 'all' | AssetKind;
type RoleFilter = 'all' | AssetRecord['role'];

const TYPE_LABEL: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

const REQUEST_STATUS_LABEL: Record<AssetGenerationRequest['status'], string> = {
  pending: '待生成',
  generating: '生成中',
  ready: '待确认',
  accepted: '已入库',
  rejected: '已忽略',
  failed: '失败',
};

const REQUEST_ROLE_LABEL: Record<AssetGenerationRequest['role'], string> = {
  object: '物件',
  background: '背景',
  texture: '纹理',
  symbol: '符号',
  overlay: '叠加层',
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '未知大小';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function assetFilePath(asset: AssetRecord): string {
  return asset.files.processed || asset.files.thumbnail || asset.files.original;
}

function versionedFileSrc(filePath: string, version?: string | number | null): string {
  const src = toFileSrc(filePath);
  return version ? `${src}?v=${encodeURIComponent(String(version))}` : src;
}

function matchesKeyword(asset: AssetRecord, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return true;
  return [
    asset.name,
    asset.role,
    asset.kind,
    asset.licenseNote ?? '',
    ...asset.semantic.tags,
    ...asset.semantic.topics,
    ...asset.semantic.style,
  ].some((item) => item.toLowerCase().includes(normalized));
}

function requestMatchesKeyword(request: AssetGenerationRequest, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return true;
  return [
    request.slot,
    request.query,
    request.role,
    request.importance,
    request.reusePolicy,
    request.visualTreatment,
    request.placementHint ?? '',
    request.prompt,
    REQUEST_STATUS_LABEL[request.status],
  ].some((item) => item.toLowerCase().includes(normalized));
}

function AssetPreview({ asset, mode }: { asset: AssetRecord; mode: 'tile' | 'inspector' }) {
  if (asset.kind === 'image') {
    const src = versionedFileSrc(assetFilePath(asset), asset.updatedAt);
    return <img src={src} alt={asset.name} draggable={false} />;
  }
  if (asset.kind === 'video') {
    if (mode === 'tile' && asset.files.thumbnail) {
      return (
        <img
          src={versionedFileSrc(asset.files.thumbnail, asset.updatedAt)}
          alt={`${asset.name} contact sheet`}
          draggable={false}
        />
      );
    }
    const src = versionedFileSrc(asset.files.processed || asset.files.original, asset.updatedAt);
    return <video src={src} muted playsInline preload={mode === 'tile' ? 'metadata' : 'auto'} />;
  }
  if (mode === 'inspector') {
    const src = versionedFileSrc(asset.files.processed || asset.files.original, asset.updatedAt);
    return <audio className={styles.audioPreview} src={src} controls preload="metadata" />;
  }
  return <Music size={mode === 'tile' ? 28 : 42} className={styles.thumbIcon} />;
}

function getContainedImageRatio(event: MouseEvent<HTMLImageElement>): { xRatio: number; yRatio: number } | null {
  const image = event.currentTarget;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return null;
  }
  const naturalRatio = image.naturalWidth / image.naturalHeight;
  const boxRatio = rect.width / rect.height;
  const renderedWidth = boxRatio > naturalRatio ? rect.height * naturalRatio : rect.width;
  const renderedHeight = boxRatio > naturalRatio ? rect.height : rect.width / naturalRatio;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const x = event.clientX - left;
  const y = event.clientY - top;
  if (x < 0 || y < 0 || x > renderedWidth || y > renderedHeight) return null;
  return {
    xRatio: x / renderedWidth,
    yRatio: y / renderedHeight,
  };
}

function ImageInspectorPreview({
  asset,
  picking,
  sampling,
  onSample,
}: {
  asset: AssetRecord;
  picking: boolean;
  sampling: boolean;
  onSample: (assetId: string, xRatio: number, yRatio: number) => void;
}) {
  const previewPath = picking ? asset.files.original : assetFilePath(asset);
  const previewVersion = picking ? asset.createdAt : asset.updatedAt;
  return (
    <div className={[styles.preview, picking ? styles.previewPicking : ''].filter(Boolean).join(' ')}>
      <img
        src={versionedFileSrc(previewPath, previewVersion)}
        alt={asset.name}
        draggable={false}
        onClick={(event) => {
          if (!picking || sampling) return;
          const point = getContainedImageRatio(event);
          if (!point) return;
          onSample(asset.id, point.xRatio, point.yRatio);
        }}
      />
      {picking ? (
        <span className={styles.previewBadge}>{sampling ? '取色中' : '原图取色'}</span>
      ) : asset.files.processed
        && (asset.files.processed !== asset.files.original || asset.metadata.previousOriginalPath) ? (
        <span className={styles.previewBadge}>处理结果</span>
      ) : null}
    </div>
  );
}

function SourceButton({
  active,
  count,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[styles.sourceButton, active ? styles.sourceButtonActive : '']
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
    >
      <span className={styles.sourceIcon}>{icon}</span>
      <span className={styles.sourceLabel}>{label}</span>
      <span className={styles.sourceCount}>{count}</span>
    </button>
  );
}

function HealthBanner({ health }: { health: ProjectAssetHealth | null }) {
  if (!health || health.issues.length === 0) return null;
  const errorCount = health.issues.filter((issue) => issue.severity === 'error').length;
  const warnCount = health.issues.length - errorCount;
  const summary = [
    errorCount > 0 ? `${errorCount} 个错误` : null,
    warnCount > 0 ? `${warnCount} 个提醒` : null,
    health.missingFiles > 0 ? `${health.missingFiles} 个文件缺失` : null,
    health.missingRefs > 0 ? `${health.missingRefs} 个引用失效` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={styles.healthBanner}>
      <AlertTriangle size={16} />
      <div className={styles.healthBody}>
        <div className={styles.healthTitle}>当前项目资产需要检查</div>
        <div className={styles.healthSummary}>{summary || '存在待处理的资产状态'}</div>
        <div className={styles.healthIssues}>
          {health.issues.slice(0, 3).map((issue, index) => (
            <span key={`${issue.kind}-${issue.assetId ?? issue.requestId ?? index}`}>
              {issue.message}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssetTile({
  asset,
  selected,
  onSelect,
}: {
  asset: AssetRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const detail = [
    TYPE_LABEL[asset.kind],
    asset.metadata.width && asset.metadata.height
      ? `${asset.metadata.width}x${asset.metadata.height}`
      : null,
    asset.metadata.durationMs ? formatTime(asset.metadata.durationMs) : null,
    asset.role,
  ].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className={[
        styles.assetTile,
        selected ? styles.assetTileSelected : '',
        asset.usage.deprecated ? styles.assetTileDeprecated : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
    >
      <span className={styles.thumb}>
        <AssetPreview asset={asset} mode="tile" />
      </span>
      <span className={styles.assetMeta}>
        <span className={styles.assetName} title={asset.name}>{asset.name}</span>
        <span className={styles.assetDetail}>{detail || asset.role}</span>
      </span>
    </button>
  );
}

function GenerationRequestList({
  requests,
  selectedId,
  workingId,
  onSelect,
  onAcceptFile,
  onReject,
  onRestore,
}: {
  requests: AssetGenerationRequest[];
  selectedId: string | null;
  workingId: string | null;
  onSelect: (requestId: string) => void;
  onAcceptFile: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onRestore: (requestId: string) => void;
}) {
  return (
    <div className={styles.requestList}>
      {requests.map((request) => {
        const done = request.status === 'accepted' || request.status === 'rejected';
        return (
          <div
            key={request.id}
            role="button"
            tabIndex={0}
            className={[
              styles.requestRow,
              request.id === selectedId ? styles.requestRowSelected : '',
              done ? styles.requestRowDimmed : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(request.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(request.id);
              }
            }}
          >
            <span className={styles.requestMain}>
              <span className={styles.requestTitleLine}>
                <span className={styles.requestQuery}>{request.query}</span>
                <span className={styles.requestStatus}>{REQUEST_STATUS_LABEL[request.status]}</span>
              </span>
              <span className={styles.requestMetaLine}>
                {REQUEST_ROLE_LABEL[request.role]} · {request.importance} · {request.visualTreatment}
              </span>
              <span className={styles.requestHint}>
                {request.placementHint || request.slot}
              </span>
            </span>
            <span className={styles.requestActions} onClick={(event) => event.stopPropagation()}>
              <Button
                variant="secondary"
                size="xs"
                leftIcon={<FileCheck2 />}
                disabled={workingId === request.id || request.status === 'accepted'}
                onClick={() => onAcceptFile(request.id)}
              >
                {request.status === 'ready' ? '确认入库' : '选择结果'}
              </Button>
              {request.status === 'rejected' ? (
                <Button
                  variant="ghost"
                  size="xs"
                  leftIcon={<RotateCcw />}
                  disabled={workingId === request.id}
                  onClick={() => onRestore(request.id)}
                >
                  恢复
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  leftIcon={<CircleOff />}
                  disabled={workingId === request.id || request.status === 'accepted'}
                  onClick={() => onReject(request.id)}
                >
                  忽略
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function GenerationRequestInspector({
  request,
  projectDir,
  workingId,
  onAcceptFile,
  onReject,
  onRestore,
}: {
  request: AssetGenerationRequest | null;
  projectDir: string | null;
  workingId: string | null;
  onAcceptFile: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onRestore: (requestId: string) => void;
}) {
  if (!request) {
    return (
      <aside className={styles.inspector}>
        <div className={styles.inspectorHeader}>
          <h2 className={styles.inspectorTitle}>生成请求</h2>
        </div>
        <div className={styles.inspectorBody}>
          <p className={styles.emptyText}>选择一个待生成请求查看 prompt、用途和入库动作。</p>
        </div>
      </aside>
    );
  }

  const canChange = workingId !== request.id && request.status !== 'accepted';
  return (
    <aside className={styles.inspector}>
      <div className={styles.inspectorHeader}>
        <h2 className={styles.inspectorTitle}>{request.query}</h2>
      </div>
      <div className={styles.inspectorBody}>
        <div className={styles.requestSummary}>
          <span className={styles.requestStatus}>{REQUEST_STATUS_LABEL[request.status]}</span>
          <span>{REQUEST_ROLE_LABEL[request.role]} · {request.importance}</span>
          <span>{request.visualTreatment}</span>
        </div>
        <div className={styles.inspectorActions}>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<CheckCircle2 />}
            disabled={!projectDir || !canChange}
            onClick={() => onAcceptFile(request.id)}
          >
            {request.status === 'ready' ? '确认生成结果入库' : '选择生成结果入库'}
          </Button>
          {request.status === 'rejected' ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RotateCcw />}
              disabled={!projectDir || workingId === request.id}
              onClick={() => onRestore(request.id)}
            >
              恢复为待生成
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<CircleOff />}
              disabled={!projectDir || !canChange}
              onClick={() => onReject(request.id)}
            >
              忽略这个请求
            </Button>
          )}
        </div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>放置意图</span>
            <span className={styles.fieldValue}>{request.placementHint || '未指定'}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>复用策略</span>
            <span className={styles.fieldValue}>{request.reusePolicy}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Prompt</span>
            <pre className={styles.promptBlock}>{request.prompt}</pre>
          </div>
          {request.negativePrompt ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>避免</span>
              <span className={styles.fieldValue}>{request.negativePrompt}</span>
            </div>
          ) : null}
          {request.generatedFilePath ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>生成结果</span>
              <span className={styles.fieldValue}>{request.generatedFilePath}</span>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function AssetInspector({
  asset,
  projectDir,
  inProject,
  chromaKeyColor,
  chromaKeying,
  replacingOriginal,
  deleting,
  pickingAssetId,
  samplingAssetId,
  onAddToProject,
  onChromaKey,
  onDelete,
  onReplaceOriginal,
  onChromaKeyColorChange,
  onSampleColor,
  onTogglePickColor,
  onUpdate,
}: {
  asset: AssetRecord | null;
  projectDir: string | null;
  inProject: boolean;
  chromaKeyColor: string;
  chromaKeying: boolean;
  replacingOriginal: boolean;
  deleting: boolean;
  pickingAssetId: string | null;
  samplingAssetId: string | null;
  onAddToProject: (assetId: string) => void;
  onChromaKey: (assetId: string, keyColor: string) => void;
  onDelete: (assetId: string) => void;
  onReplaceOriginal: (assetId: string) => void;
  onChromaKeyColorChange: (value: string) => void;
  onSampleColor: (assetId: string, xRatio: number, yRatio: number) => void;
  onTogglePickColor: (assetId: string) => void;
  onUpdate: (assetId: string, patch: AssetUpdatePatch) => void;
}) {
  if (!asset) {
    return (
      <aside className={styles.inspector}>
        <div className={styles.inspectorHeader}>
          <h2 className={styles.inspectorTitle}>资产详情</h2>
        </div>
        <div className={styles.inspectorBody}>
          <p className={styles.emptyText}>选择一个素材查看来源、处理档案和项目引用。</p>
        </div>
      </aside>
    );
  }

  const size = [
    asset.metadata.width && asset.metadata.height
      ? `${asset.metadata.width} x ${asset.metadata.height}`
      : null,
    asset.metadata.durationMs ? `${Math.round(asset.metadata.durationMs / 1000)}s` : null,
    formatBytes(asset.metadata.byteSize),
  ].filter(Boolean).join(' · ');
  const hasProcessedFile = Boolean(
    asset.files.processed
      && (asset.files.processed !== asset.files.original || asset.metadata.previousOriginalPath),
  );
  const picking = pickingAssetId === asset.id;
  const sampling = samplingAssetId === asset.id;

  return (
    <aside className={styles.inspector}>
      <div className={styles.inspectorHeader}>
        <h2 className={styles.inspectorTitle}>{asset.name}</h2>
      </div>
      <div className={styles.inspectorBody}>
        {asset.kind === 'image' ? (
          <ImageInspectorPreview
            asset={asset}
            picking={picking}
            sampling={sampling}
            onSample={onSampleColor}
          />
        ) : (
          <div className={styles.preview}>
            <AssetPreview asset={asset} mode="inspector" />
          </div>
        )}
        {asset.kind === 'audio' ? (
          <div className={styles.assetWaveform}>
            <TimelineAudioWaveform
              audioPath={asset.files.processed || asset.files.original}
              durationMs={asset.metadata.durationMs ?? 0}
              trackWidth={260}
              trackHeight={56}
              loadDelayMs={0}
            />
          </div>
        ) : null}
        <div className={styles.inspectorActions}>
          <Button
            variant="primary"
            size="sm"
            disabled={!projectDir || inProject || deleting}
            onClick={() => onAddToProject(asset.id)}
          >
            {inProject ? '已在当前项目' : '加入当前项目'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={deleting}
            onClick={() => window.electronAPI.showItemInFolder(asset.files.original)}
          >
            显示原图
          </Button>
          {hasProcessedFile ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={deleting}
              onClick={() => window.electronAPI.showItemInFolder(asset.files.processed || asset.files.original)}
            >
              显示处理结果
            </Button>
          ) : null}
        </div>
        <div className={styles.libraryControls}>
          <Button
            variant={asset.usage.favorite ? 'primary' : 'secondary'}
            size="sm"
            leftIcon={<Star size={12} fill={asset.usage.favorite ? 'currentColor' : 'none'} />}
            onClick={() => onUpdate(asset.id, { favorite: !asset.usage.favorite })}
          >
            {asset.usage.favorite ? '已收藏' : '收藏'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<CircleOff size={12} />}
            onClick={() => onUpdate(asset.id, { deprecated: !asset.usage.deprecated })}
          >
            {asset.usage.deprecated ? '恢复推荐' : '不再推荐'}
          </Button>
          <span className={styles.ratingGroup} aria-label="素材评分">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                type="button"
                className={styles.ratingButton}
                title={`${rating} 星`}
                aria-label={`${rating} 星`}
                aria-pressed={(asset.usage.rating ?? 0) >= rating}
                onClick={() => onUpdate(asset.id, {
                  rating: asset.usage.rating === rating ? null : rating as 1 | 2 | 3 | 4 | 5,
                })}
              >
                <Star size={13} fill={(asset.usage.rating ?? 0) >= rating ? 'currentColor' : 'none'} />
              </button>
            ))}
          </span>
        </div>
        {asset.kind === 'audio' ? (
          <AudioAssetMetadataEditor asset={asset} onUpdate={onUpdate} />
        ) : null}
        {asset.kind === 'image' ? (
          <div className={styles.chromaKeyPanel}>
            <ColorField
              label="抠图颜色"
              value={chromaKeyColor}
              onChange={onChromaKeyColorChange}
              showValue
              disabled={chromaKeying}
              className={styles.chromaKeyColor}
            />
            <Button
              variant={picking ? 'primary' : 'secondary'}
              size="sm"
              fullWidth
              className={styles.chromaKeyButton}
              leftIcon={<Pipette size={12} />}
              disabled={sampling || chromaKeying || deleting}
              onClick={() => onTogglePickColor(asset.id)}
            >
              {picking ? '完成取色' : '原图取色'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              className={styles.chromaKeyButton}
              leftIcon={<Scissors size={12} />}
              disabled={chromaKeying || sampling || deleting}
              onClick={() => onChromaKey(asset.id, chromaKeyColor)}
            >
              {chromaKeying ? '处理中...' : '抠图'}
            </Button>
          </div>
        ) : null}
        {hasProcessedFile ? (
          <Button
            variant="accent"
            size="sm"
            fullWidth
            className={styles.replaceOriginalButton}
            leftIcon={<FileCheck2 size={12} />}
            disabled={replacingOriginal || chromaKeying || sampling || deleting}
            onClick={() => onReplaceOriginal(asset.id)}
          >
            {replacingOriginal ? '替换中...' : '用处理结果替换原图'}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          fullWidth
          className={styles.deleteAssetButton}
          leftIcon={<Trash2 size={12} />}
          disabled={deleting || chromaKeying || sampling || replacingOriginal}
          onClick={() => onDelete(asset.id)}
        >
          {deleting ? '删除中...' : '删除资产'}
        </Button>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>类型</span>
            <span className={styles.fieldValue}>{TYPE_LABEL[asset.kind]} · {asset.role}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>文件</span>
            <span className={styles.fieldValue}>{size}</span>
          </div>
          {hasProcessedFile ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>处理结果</span>
              <span className={styles.fieldValue}>
                {asset.files.processed}
                {asset.metadata.processedByteSize
                  ? ` · ${formatBytes(asset.metadata.processedByteSize)}`
                  : ''}
              </span>
            </div>
          ) : null}
          {asset.metadata.processedAt ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>抠图记录</span>
              <span className={styles.fieldValue}>
                {asset.metadata.processedColorKey || '#00ff00'} · {new Date(asset.metadata.processedAt).toLocaleString()}
              </span>
            </div>
          ) : null}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>视觉处理</span>
            <span className={styles.fieldValue}>{asset.treatment.profile}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>来源</span>
            <span className={styles.fieldValue}>{asset.sourceUri || asset.sourceType}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>标签</span>
            <span className={styles.tagRow}>
              {[...asset.semantic.tags, ...asset.semantic.style].length > 0
                ? [...asset.semantic.tags, ...asset.semantic.style].map((tag) => (
                    <span key={tag} className={styles.tag}>{tag}</span>
                  ))
                : <span className={styles.fieldValue}>暂无标签</span>}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function AssetCenter({
  projectDir,
  focusAssetId,
}: {
  projectDir: string | null;
  focusAssetId?: string | null;
}) {
  const [library, setLibrary] = useState<AssetLibraryFile | null>(null);
  const [projectManifest, setProjectManifest] = useState<ProjectAssetManifest | null>(null);
  const [health, setHealth] = useState<ProjectAssetHealth | null>(null);
  const [source, setSource] = useState<SourceKey>('global');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [workingRequestId, setWorkingRequestId] = useState<string | null>(null);
  const [chromaKeyColor, setChromaKeyColor] = useState('#00ff00');
  const [chromaKeyingId, setChromaKeyingId] = useState<string | null>(null);
  const [replacingOriginalId, setReplacingOriginalId] = useState<string | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [pickingAssetId, setPickingAssetId] = useState<string | null>(null);
  const [samplingAssetId, setSamplingAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyState = useCallback((state: AssetLibraryState) => {
    setLibrary(state.library);
    setProjectManifest(state.projectManifest);
    setHealth(state.health);
    useAIStore.getState().reconcileAssetBindings(state.library);
  }, []);

  const refreshAssetState = useCallback(async () => {
    const state = await window.electronAPI.getAssetLibraryState(projectDir);
    applyState(state);
    return state;
  }, [applyState, projectDir]);

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const state = await refreshAssetState();
      setSelectedId((current) => current ?? state.library.assets[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取资产库失败');
    } finally {
      setLoading(false);
    }
  }, [refreshAssetState]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const projectAssetIds = useMemo(
    () => new Set(projectManifest?.assetRefs.map((ref) => ref.assetId) ?? []),
    [projectManifest],
  );

  useEffect(() => {
    if (!focusAssetId || !library?.assets.some((asset) => asset.id === focusAssetId)) return;
    setSelectedId(focusAssetId);
    setSource(projectAssetIds.has(focusAssetId) ? 'project' : 'global');
  }, [focusAssetId, library?.assets, projectAssetIds]);

  const visibleAssets = useMemo(() => {
    const all = library?.assets ?? [];
    const isProjectAsset = (asset: AssetRecord) =>
      asset.sourceType === 'project-local' || projectAssetIds.has(asset.id);
    const scoped = source === 'project'
      ? all.filter(isProjectAsset)
      : source === 'pending'
        ? []
        : all.filter((asset) => asset.sourceType !== 'project-local');
    return scoped.filter((asset) => {
      if (typeFilter !== 'all' && asset.kind !== typeFilter) return false;
      if (roleFilter !== 'all' && asset.role !== roleFilter) return false;
      return matchesKeyword(asset, keyword);
    });
  }, [keyword, library?.assets, projectAssetIds, roleFilter, source, typeFilter]);

  const roleOptions = useMemo<RoleFilter[]>(() => {
    if (typeFilter === 'audio') return ['all', 'bgm', 'stinger', 'sfx', 'ambience', 'transition-sound'];
    if (typeFilter === 'video') return ['all', 'broll', 'background-loop', 'overlay', 'transition-video', 'greenscreen-video'];
    return ['all'];
  }, [typeFilter]);

  const generationRequests = projectManifest?.generationRequests ?? [];

  const visibleRequests = useMemo(() => {
    return generationRequests.filter((request) => requestMatchesKeyword(request, keyword));
  }, [generationRequests, keyword]);

  const selectedAsset = useMemo(
    () => (library?.assets ?? []).find((asset) => asset.id === selectedId) ?? null,
    [library?.assets, selectedId],
  );

  const selectedRequest = useMemo(
    () => generationRequests.find((request) => request.id === selectedRequestId) ?? visibleRequests[0] ?? null,
    [generationRequests, selectedRequestId, visibleRequests],
  );

  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.importAssetLibraryFiles({ projectDir });
      await refreshAssetState();
      if (result.imported[0]) setSelectedId(result.imported[0].id);
      if (result.skipped.length > 0) {
        setError(`有 ${result.skipped.length} 个文件未导入`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入资产失败');
    } finally {
      setImporting(false);
    }
  }, [projectDir, refreshAssetState]);

  const handleAddToProject = useCallback(async (assetId: string) => {
    if (!projectDir) return;
    await window.electronAPI.addAssetToProjectLibrary(projectDir, assetId);
    await refreshAssetState();
    setSource('project');
  }, [projectDir, refreshAssetState]);

  const handleUpdateAsset = useCallback(async (assetId: string, patch: AssetUpdatePatch) => {
    setError(null);
    try {
      await window.electronAPI.updateAssetLibraryAsset(assetId, patch);
      await refreshAssetState();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新素材属性失败');
    }
  }, [refreshAssetState]);

  const handleChromaKeyAsset = useCallback(async (assetId: string, keyColor: string) => {
    setChromaKeyingId(assetId);
    setPickingAssetId(null);
    setError(null);
    try {
      const result = await window.electronAPI.chromaKeyAssetLibraryAsset({ assetId, keyColor, projectDir });
      await refreshAssetState();
      setSelectedId(result.asset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '资产抠图失败');
    } finally {
      setChromaKeyingId(null);
    }
  }, [projectDir, refreshAssetState]);

  const handleReplaceOriginal = useCallback(async (assetId: string) => {
    setReplacingOriginalId(assetId);
    setPickingAssetId(null);
    setError(null);
    try {
      const result = await window.electronAPI.replaceAssetOriginalWithProcessed(assetId, projectDir);
      await refreshAssetState();
      setSelectedId(result.asset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '替换原图失败');
    } finally {
      setReplacingOriginalId(null);
    }
  }, [projectDir, refreshAssetState]);

  const handleDeleteAsset = useCallback(async (assetId: string) => {
    const asset = library?.assets.find((item) => item.id === assetId);
    const label = asset?.name || '这个资产';
    if (!window.confirm(`确定删除「${label}」吗？资产库内的文件会移到废纸篓，并从当前项目引用中移除。`)) {
      return;
    }
    setDeletingAssetId(assetId);
    setPickingAssetId(null);
    setError(null);
    try {
      const result = await window.electronAPI.deleteAssetLibraryAsset({ assetId, projectDir });
      const state = await refreshAssetState();
      setSelectedId((current) => (
        current === assetId
          ? state.library.assets[0]?.id ?? null
          : current
      ));
      if (result.failedFiles.length > 0) {
        setError(`资产已从库中移除，但有 ${result.failedFiles.length} 个文件未能移到废纸篓`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除资产失败');
    } finally {
      setDeletingAssetId(null);
    }
  }, [library?.assets, projectDir, refreshAssetState]);

  const handleSampleAssetColor = useCallback(async (
    assetId: string,
    xRatio: number,
    yRatio: number,
  ) => {
    setSamplingAssetId(assetId);
    setError(null);
    try {
      const sampled = await window.electronAPI.sampleAssetLibraryColor({
        assetId,
        xRatio,
        yRatio,
        projectDir,
      });
      setChromaKeyColor(sampled.keyColor);
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片取色失败');
    } finally {
      setSamplingAssetId(null);
    }
  }, [projectDir]);

  const handleTogglePickColor = useCallback((assetId: string) => {
    setPickingAssetId((current) => (current === assetId ? null : assetId));
  }, []);

  const handleAcceptGeneratedFile = useCallback(async (requestId: string) => {
    if (!projectDir) return;
    setWorkingRequestId(requestId);
    setError(null);
    try {
      const request = projectManifest?.generationRequests.find((item) => item.id === requestId);
      if (request?.status === 'ready' && request.resultAssetId) {
        await window.electronAPI.updateAssetGenerationRequest({
          projectDir,
          requestId,
          patch: { status: 'accepted' },
        });
        await refreshAssetState();
        setSelectedId(request.resultAssetId);
        setSource('project');
        return;
      }
      const filePath = await window.electronAPI.selectMediaFile('image');
      if (!filePath) return;
      const result = await window.electronAPI.acceptGeneratedAssetFile({
        projectDir,
        requestId,
        filePath,
      });
      await refreshAssetState();
      setSelectedId(result.asset.id);
      setSource('project');
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认生成资产失败');
    } finally {
      setWorkingRequestId(null);
    }
  }, [projectDir, projectManifest?.generationRequests, refreshAssetState]);

  const handleUpdateRequestStatus = useCallback(async (
    requestId: string,
    status: AssetGenerationRequest['status'],
  ) => {
    if (!projectDir) return;
    setWorkingRequestId(requestId);
    setError(null);
    try {
      await window.electronAPI.updateAssetGenerationRequest({
        projectDir,
        requestId,
        patch: { status },
      });
      await refreshAssetState();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新生成请求失败');
    } finally {
      setWorkingRequestId(null);
    }
  }, [projectDir, refreshAssetState]);

  const counts = {
    global: (library?.assets ?? []).filter((asset) => asset.sourceType !== 'project-local').length,
    project: (library?.assets ?? []).filter(
      (asset) => asset.sourceType === 'project-local' || projectAssetIds.has(asset.id),
    ).length,
    pending: generationRequests.filter(
      (request) => request.status !== 'accepted' && request.status !== 'rejected',
    ).length,
  };

  return (
    <div className={styles.root}>
      <aside className={styles.rail}>
        <p className={styles.railTitle}>资产来源</p>
        <SourceButton
          active={source === 'global'}
          count={counts.global}
          icon={<Archive size={15} />}
          label="全局素材库"
          onClick={() => setSource('global')}
        />
        <SourceButton
          active={source === 'project'}
          count={counts.project}
          icon={<FolderCheck size={15} />}
          label="当前项目"
          onClick={() => setSource('project')}
        />
        <SourceButton
          active={source === 'pending'}
          count={counts.pending}
          icon={<Sparkles size={15} />}
          label="待生成"
          onClick={() => setSource('pending')}
        />
      </aside>
      <main className={styles.main}>
        <div className={styles.toolbar}>
          <div className={styles.heading}>
            <div className={styles.titleRow}>
              <Box size={16} />
              <h1 className={styles.title}>资产中心</h1>
            </div>
            <p className={styles.subtitle}>
              同时扫描全局素材库与当前项目目录，让 AI 卡片、封面和手动导入素材保持同一套来源视图。
            </p>
          </div>
          <div className={styles.toolbarActions}>
            <Button variant="secondary" size="sm" onClick={() => void loadState()}>
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleImport()} disabled={importing}>
              {importing ? '导入中...' : '导入素材'}
            </Button>
          </div>
        </div>
        <div className={styles.filters}>
          <SearchInput
            className={styles.search}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索名称、标签、来源"
          />
          <div className={styles.filterTabs}>
            {(['all', 'image', 'video', 'audio'] as TypeFilter[]).map((item) => (
              <button
                key={item}
                type="button"
                className={[
                  styles.typeButton,
                  typeFilter === item ? styles.typeButtonActive : '',
                ].filter(Boolean).join(' ')}
                onClick={() => {
                  setTypeFilter(item);
                  setRoleFilter('all');
                }}
              >
                {item === 'all' ? '全部' : TYPE_LABEL[item]}
              </button>
            ))}
          </div>
        </div>
        {roleOptions.length > 1 ? (
          <div className={styles.roleTabs} aria-label="素材角色筛选">
            {roleOptions.map((role) => (
              <button
                key={role}
                type="button"
                className={[
                  styles.typeButton,
                  roleFilter === role ? styles.typeButtonActive : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setRoleFilter(role)}
              >
                {role === 'all' ? '全部用途' : role}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.content}>
          <HealthBanner health={health} />
          {loading ? (
            <div className={styles.empty}>正在读取资产库...</div>
          ) : error ? (
            <div className={styles.empty}>{error}</div>
          ) : source === 'pending' && visibleRequests.length > 0 ? (
            <GenerationRequestList
              requests={visibleRequests}
              selectedId={selectedRequest?.id ?? null}
              workingId={workingRequestId}
              onSelect={setSelectedRequestId}
              onAcceptFile={(requestId) => void handleAcceptGeneratedFile(requestId)}
              onReject={(requestId) => void handleUpdateRequestStatus(requestId, 'rejected')}
              onRestore={(requestId) => void handleUpdateRequestStatus(requestId, 'pending')}
            />
          ) : visibleAssets.length > 0 ? (
            <div className={styles.grid}>
              {visibleAssets.map((asset) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  selected={asset.id === selectedId}
                  onSelect={() => setSelectedId(asset.id)}
                />
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyInner}>
                {source === 'pending' ? <Sparkles size={28} /> : <Image size={28} />}
                <h2 className={styles.emptyTitle}>
                  {source === 'pending' ? '暂无待生成请求' : '还没有可用资产'}
                </h2>
                <p className={styles.emptyText}>
                  {source === 'pending'
                    ? '模型卡片导演规划出的物件、背景和纹理需求会出现在这里，确认后即可沉淀为项目资产。'
                    : '导入常用物件、背景、纹理或视频素材，建立可跨项目复用的视觉库。'}
                </p>
                {source !== 'pending' ? (
                  <Button variant="primary" size="sm" onClick={() => void handleImport()}>
                    导入素材
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </main>
      {source === 'pending' ? (
        <GenerationRequestInspector
          request={selectedRequest}
          projectDir={projectDir}
          workingId={workingRequestId}
          onAcceptFile={(requestId) => void handleAcceptGeneratedFile(requestId)}
          onReject={(requestId) => void handleUpdateRequestStatus(requestId, 'rejected')}
          onRestore={(requestId) => void handleUpdateRequestStatus(requestId, 'pending')}
        />
      ) : (
        <AssetInspector
          asset={selectedAsset}
          projectDir={projectDir}
          inProject={selectedAsset
            ? selectedAsset.sourceType === 'project-local' || projectAssetIds.has(selectedAsset.id)
            : false}
          chromaKeyColor={chromaKeyColor}
          chromaKeying={selectedAsset ? chromaKeyingId === selectedAsset.id : false}
          replacingOriginal={selectedAsset ? replacingOriginalId === selectedAsset.id : false}
          deleting={selectedAsset ? deletingAssetId === selectedAsset.id : false}
          pickingAssetId={pickingAssetId}
          samplingAssetId={samplingAssetId}
          onAddToProject={handleAddToProject}
          onChromaKey={(assetId, keyColor) => void handleChromaKeyAsset(assetId, keyColor)}
          onDelete={(assetId) => void handleDeleteAsset(assetId)}
          onReplaceOriginal={(assetId) => void handleReplaceOriginal(assetId)}
          onChromaKeyColorChange={setChromaKeyColor}
          onSampleColor={(assetId, xRatio, yRatio) => void handleSampleAssetColor(assetId, xRatio, yRatio)}
          onTogglePickColor={handleTogglePickColor}
          onUpdate={handleUpdateAsset}
        />
      )}
    </div>
  );
}
