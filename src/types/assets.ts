export type AssetKind = 'image' | 'video' | 'audio';

export type AssetRole =
  | 'object'
  | 'background'
  | 'texture'
  | 'symbol'
  | 'video'
  | 'greenscreen-video'
  | 'overlay'
  | 'audio'
  | 'bgm'
  | 'stinger'
  | 'sfx'
  | 'ambience'
  | 'transition-sound'
  | 'broll'
  | 'background-loop'
  | 'transition-video';

export type AssetSourceType = 'manual-import' | 'ai-generated' | 'project-local';

export type AssetTreatmentProfile =
  | 'editorial-realist-cutout'
  | 'documentary-desk'
  | 'technical-product'
  | 'paper-archive'
  | 'diagram-prop';

export interface AssetFiles {
  original: string;
  processed?: string | null;
  thumbnail?: string | null;
  mask?: string | null;
}

export interface AssetMetadata {
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  hasAlpha?: boolean;
  processedAt?: string | null;
  processedByteSize?: number | null;
  processedColorKey?: string | null;
  originalReplacedAt?: string | null;
  previousOriginalPath?: string | null;
  contentHash: string;
  byteSize: number;
  mimeHint?: string;
  /** 同一媒体换封装后仍稳定的内容指纹；缺省时回退 contentHash。 */
  normalizedContentHash?: string;
  reuseKey?: string;
  audio?: {
    integratedLufs?: number | null;
    truePeakDbtp?: number | null;
    bpm?: number | null;
    key?: string | null;
    loopable?: boolean;
    loopStartMs?: number | null;
    loopEndMs?: number | null;
    energy?: 1 | 2 | 3;
    transientType?: string | null;
  };
  video?: {
    fps?: number | null;
    aspectRatio?: string | null;
    hasAudio?: boolean;
    loopable?: boolean;
    motionIntensity?: 1 | 2 | 3;
    shotType?: string | null;
    subject?: string | null;
    action?: string | null;
    perceptualHash?: string | null;
  };
  provenance?: {
    provider: string;
    model?: string | null;
    taskId?: string | null;
    promptHash?: string | null;
    requestHash?: string | null;
    variantGroupId?: string | null;
    generatedAt?: string | null;
  };
  quality?: {
    status: 'pending' | 'passed' | 'rejected';
    issues?: string[];
  };
}

export interface AssetSemantic {
  tags: string[];
  topics: string[];
  style: string[];
  usableAs: string[];
}

export interface AssetTreatment {
  profile: AssetTreatmentProfile;
  lighting: string;
  palette: string;
  shadow: string;
  perspective: string;
}

export interface AssetUsage {
  lastUsedAt?: string | null;
  projectRefs: string[];
  favorite: boolean;
  usageCount?: number;
  rating?: 1 | 2 | 3 | 4 | 5 | null;
  deprecated?: boolean;
}

export interface AssetRecord {
  id: string;
  name: string;
  kind: AssetKind;
  role: AssetRole;
  sourceType: AssetSourceType;
  sourceUri?: string;
  licenseNote?: string;
  createdAt: string;
  updatedAt: string;
  files: AssetFiles;
  metadata: AssetMetadata;
  semantic: AssetSemantic;
  treatment: AssetTreatment;
  usage: AssetUsage;
}

export interface AssetLibrarySettings {
  rootDir: string;
  defaultImportMode: 'copy';
  defaultProjectReferenceMode: 'reference-global' | 'copy-to-project';
}

export interface AssetLibraryFile {
  version: 2;
  libraryId: string;
  settings: AssetLibrarySettings;
  assets: AssetRecord[];
  updatedAt: string;
}

export type ProjectAssetScope = 'global' | 'project';

export interface ProjectAssetUsageRef {
  type: 'motion-card' | 'timeline' | 'cover' | 'manual';
  id?: string;
  slot?: string;
}

export interface ProjectAssetRef {
  assetId: string;
  scope: ProjectAssetScope;
  globalLibraryId?: string;
  snapshotPath?: string | null;
  addedAt: string;
  usedBy: ProjectAssetUsageRef[];
}

export type AssetGenerationStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'accepted'
  | 'rejected'
  | 'failed';

export interface AssetGenerationRequest {
  id: string;
  slot: string;
  query: string;
  role: Extract<AssetRole, 'object' | 'background' | 'texture' | 'symbol' | 'overlay'>;
  importance: 'primary' | 'secondary' | 'ambient';
  reusePolicy: 'prefer-library' | 'generate-if-missing' | 'always-generate' | 'manual-only';
  visualTreatment: AssetTreatmentProfile;
  revealBeat?: number;
  placementHint?: string;
  negativePrompt?: string;
  prompt: string;
  status: AssetGenerationStatus;
  sourceCardId?: string;
  resultAssetId?: string;
  generatedFilePath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAssetManifest {
  version: 1;
  projectDir: string;
  assetRefs: ProjectAssetRef[];
  generationRequests: AssetGenerationRequest[];
  updatedAt: string;
}

export type AssetHealthIssueKind =
  | 'missing-original'
  | 'missing-processed'
  | 'missing-project-ref'
  | 'missing-generation-result';

export interface AssetHealthIssue {
  kind: AssetHealthIssueKind;
  severity: 'error' | 'warn';
  assetId?: string;
  requestId?: string;
  filePath?: string;
  message: string;
}

export interface ProjectAssetHealth {
  ok: boolean;
  checkedAt: string;
  missingFiles: number;
  missingRefs: number;
  issues: AssetHealthIssue[];
}

export interface AssetLibraryState {
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest | null;
  health: ProjectAssetHealth | null;
}

export interface AssetImportRequest {
  projectDir?: string | null;
  filePaths?: string[];
}

export interface AssetImportResult {
  imported: AssetRecord[];
  skipped: Array<{ path: string; reason: string }>;
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest | null;
}

export interface GeneratedAssetImportRequest {
  filePath: string;
  projectDir?: string | null;
  name: string;
  role: AssetRole;
  reuseKey: string;
  semantic?: Partial<AssetSemantic>;
  licenseNote?: string;
  provenance: NonNullable<AssetMetadata['provenance']>;
  audio?: AssetMetadata['audio'];
  video?: AssetMetadata['video'];
}

export interface AssetUpdatePatch {
  name?: string;
  role?: AssetRole;
  licenseNote?: string;
  semantic?: Partial<AssetSemantic>;
  audio?: Partial<NonNullable<AssetMetadata['audio']>>;
  treatment?: Partial<AssetTreatment>;
  favorite?: boolean;
  rating?: 1 | 2 | 3 | 4 | 5 | null;
  deprecated?: boolean;
}

export interface AssetChromaKeyRequest {
  assetId: string;
  keyColor?: string;
  projectDir?: string | null;
}

export interface AssetDeleteRequest {
  assetId: string;
  projectDir?: string | null;
}

export interface AssetDeleteResult {
  deletedAssetId: string;
  trashedFiles: string[];
  failedFiles: Array<{ path: string; reason: string }>;
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest | null;
}

export interface AssetChromaKeyResult {
  asset: AssetRecord;
  library: AssetLibraryFile;
  outputPath: string;
  byteSize: number;
  width: number;
  height: number;
}

export interface AssetSampleColorRequest {
  assetId: string;
  xRatio: number;
  yRatio: number;
  projectDir?: string | null;
}

export interface AssetSampleColorResult {
  keyColor: string;
  r: number;
  g: number;
  b: number;
  x: number;
  y: number;
}

export interface AssetReplaceOriginalResult {
  asset: AssetRecord;
  library: AssetLibraryFile;
}

export interface StoryboardAssetRequest {
  slot: string;
  query: string;
  role: Extract<AssetRole, 'object' | 'background' | 'texture' | 'symbol' | 'overlay'>;
  importance: 'primary' | 'secondary' | 'ambient';
  reusePolicy: 'prefer-library' | 'generate-if-missing' | 'always-generate' | 'manual-only';
  visualTreatment: AssetTreatmentProfile;
  /** 资产应随分镜第几拍揭示；缺省时由 importance 与顺序推导。 */
  revealBeat?: number;
  placementHint?: string;
  negativePrompt?: string;
}

export interface CardAssetBinding {
  slot: string;
  assetId: string;
  filePath: string;
  /** Agent 合成媒体的真实类型；旧图片绑定可缺省，由文件扩展名推断。 */
  kind?: 'image' | 'video';
  /** Agent 可自行舍弃可选素材，但必须使用 required 素材。 */
  usage?: 'required' | 'optional';
  /** 视频从源文件的该时间点开始播放。 */
  trimStartMs?: number;
  /** 媒体源时长；视频渲染时用于限制 trimAfter。 */
  durationMs?: number;
  /** 旧版布尔字段兼容；新数据优先使用 usage。 */
  required?: boolean;
  /** 用户已锁定，制作链路不得静默替换。 */
  lockedByUser?: boolean;
  /** 锁定时记录的本机文件指纹，制作 / 恢复阶段用于验证没有被静默替换。 */
  fileFingerprint?: string;
  /** 视频候选的预览缩略图，不参与最终真帧渲染。 */
  thumbnailFile?: string;
  treatment: AssetTreatment;
  metadata?: Pick<
    AssetMetadata,
    | 'width'
    | 'height'
    | 'durationMs'
    | 'hasAlpha'
    | 'processedAt'
    | 'processedColorKey'
    | 'mimeHint'
    | 'normalizedContentHash'
    | 'video'
  >;
  placement: {
    x: number;
    y: number;
    width: number;
    height?: number;
    rotation?: number;
    opacity?: number;
    depth?: 'background' | 'midground' | 'foreground';
    /** placement 坐标的设计基准画布；渲染时按实际 Composition 等比换算。 */
    referenceWidth?: number;
    referenceHeight?: number;
  };
  motion?: {
    enter?: 'fade-up-soft' | 'fade-in' | 'slide-left' | 'hold';
    emphasis?: 'subtle-parallax' | 'none';
    exit?: 'hold' | 'fade-out';
    revealBeat?: number;
  };
  request?: StoryboardAssetRequest;
}

export interface AssetResolutionResult {
  bindings: CardAssetBinding[];
  generationRequests: AssetGenerationRequest[];
  unresolved: StoryboardAssetRequest[];
  activity?: {
    requested: number;
    matched: number;
    generated: number;
    failed: number;
    cutoutReady: number;
    cutoutFailed: number;
    durationMs: number;
    /** 命动手动素材约定（卡目录用户文件）直接绑定的数量；这些请求未经素材库匹配与 AI 生成。 */
    manual?: number;
  };
}

export interface AssetResolutionState extends AssetResolutionResult {
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest | null;
}

export interface AssetAcceptGeneratedResult {
  asset: AssetRecord;
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest;
}

export const DEFAULT_ASSET_TREATMENT: AssetTreatment = {
  profile: 'editorial-realist-cutout',
  lighting: 'soft-left',
  palette: 'low-saturation',
  shadow: 'soft-ground',
  perspective: 'front-3q',
};

export const EMPTY_ASSET_SEMANTIC: AssetSemantic = {
  tags: [],
  topics: [],
  style: ['写实', '低饱和'],
  usableAs: [],
};
