export const VIDEO_IMPORT_SOURCE_TYPES = ['douyin', 'local_video', 'local_audio'] as const;

export type VideoImportSourceType = (typeof VIDEO_IMPORT_SOURCE_TYPES)[number];

export const VIDEO_IMPORT_STATUSES = [
  'downloading',
  'extracting_audio',
  'transcribing',
  'syncing',
  'done',
  'error',
] as const;

export type VideoImportStatus = (typeof VIDEO_IMPORT_STATUSES)[number];

export type VideoImportRequest =
  | {
      sourceType: 'douyin';
      url: string;
      projectDir: string;
      syncToOriginal?: boolean;
    }
  | {
      sourceType: 'local_video' | 'local_audio';
      filePath: string;
      projectDir: string;
      syncToOriginal?: boolean;
    };

export type VideoImportSourceInput =
  | {
      sourceType: 'douyin';
      url: string;
    }
  | {
      sourceType: 'local_video' | 'local_audio';
      filePath: string;
    };

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  words?: TranscriptWord[];
}

export interface VideoImportResult {
  importId: string;
  sourceType: VideoImportSourceType;
  videoId: string;
  title: string;
  projectDir: string;
  importDir: string;
  videoPath: string;
  audioPath: string;
  transcriptPath: string;
  transcriptSrtPath: string;
  originalPath: string;
  sourceMetadataPath: string;
  resultMetadataPath: string;
  previewMetadataPath: string;
  sourceUrl?: string;
  resolvedPageUrl?: string;
  sourcePath?: string;
  coverUrl?: string;
  engine: 'bcut';
  syncedToOriginal: boolean;
  createdAt: string;
}

export interface VideoImportPreviewDocument {
  schema: 'video-import-preview';
  version: 1;
  sourceType: VideoImportSourceType;
  title: string;
  videoId: string;
  createdAt: string;
  syncedToOriginal: boolean;
  engine: VideoImportResult['engine'];
  projectDir: string;
  importDir: string;
  media: {
    videoPath: string;
    audioPath: string;
    coverUrl?: string;
  };
  transcript: {
    markdownPath: string;
    srtPath: string;
    text: string;
    srtText: string;
    segments: TranscriptSegment[];
  };
  metadata: {
    sourceUrl?: string;
    resolvedPageUrl?: string;
    sourcePath?: string;
    originalPath: string;
    sourceMetadataPath: string;
    resultMetadataPath: string;
  };
}

export interface VideoImportProgress {
  importId: string;
  sourceType: VideoImportSourceType;
  status: VideoImportStatus;
  progress: number;
  stepLabel: string;
  error?: string;
  result?: VideoImportResult;
}
