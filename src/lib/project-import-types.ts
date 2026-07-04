/** 共享契约：项目导入功能的 Renderer / Main 对齐点。锁定后请勿随意修改。 */

export type ImportProjectScenario = 'complete' | 'mediaOnly' | 'unrecognized';

export type DetectedFileKind =
  | 'projectJson'
  | 'scriptMd'
  | 'originalMd'
  | 'audioMp3'
  | 'subtitleSrt'
  | 'coverImage'
  | 'aiCard'
  | 'douyinImport'
  | 'promptOverride'
  | 'other';

export interface DetectedFile {
  relativePath: string;
  bytes: number;
  kind: DetectedFileKind;
}

export type AssetReferenceKind =
  | 'overlayAsset'
  | 'podcastAudio'
  | 'podcastSubtitle'
  | 'ttsAsset';

export interface MissingAssetItem {
  /** overlay 资源或 tts 资源的 id */
  refId?: string;
  kind: AssetReferenceKind;
  originalPath: string;
  basename: string;
}

export interface AssetReferenceSummary {
  totalReferences: number;
  intactCount: number;
  fixableCount: number;
  missingCount: number;
  /** 最多返回 50 条，避免 IPC 负载膨胀 */
  missingItems: MissingAssetItem[];
}

export interface ImportProjectScanResult {
  projectDir: string;
  projectName: string;
  scenario: ImportProjectScenario;
  detectedFiles: DetectedFile[];
  timelineItemCount: number;
  coverCandidateCount: number;
  assetReferences: AssetReferenceSummary;
  blockReason?: string;
}

export interface AssetFixItem {
  kind: AssetReferenceKind;
  refId?: string;
  originalPath: string;
  newPath: string;
}

export interface AssetFixReport {
  fixed: AssetFixItem[];
  missing: MissingAssetItem[];
}

export interface ImportProjectResult {
  projectDir: string;
  projectName: string;
  scenario: Exclude<ImportProjectScenario, 'unrecognized'>;
  fixReport: AssetFixReport;
}

export interface ImportProjectArgs {
  projectDir: string;
  acceptMissingAssets: boolean;
}

export type ImportProjectErrorCode =
  | 'unrecognized'
  | 'missing_assets'
  | 'scan_failed'
  | 'load_failed'
  | 'save_failed';

export interface ImportProjectErrorPayload {
  code: ImportProjectErrorCode;
  message: string;
}
