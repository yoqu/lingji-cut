export type SunoMusicModel = 'V5' | 'V5_5';

export interface AudioGenerationConfig {
  baseUrl: string;
  apiKey: string;
  callbackUrl: string;
  musicModel: SunoMusicModel;
}

export interface MusicGenerationRequest {
  title: string;
  style: string;
  negativeTags?: string;
  model?: SunoMusicModel;
  styleWeight?: number;
  weirdnessConstraint?: number;
}

export interface SoundGenerationRequest {
  prompt: string;
  soundLoop?: boolean;
  soundTempo?: number;
  soundKey?: string;
}

export interface AudioTask {
  taskId: string;
  kind: 'music' | 'sound';
}

export interface AudioCandidate {
  id: string;
  audioUrl: string;
  streamAudioUrl?: string;
  title?: string;
  tags?: string;
  durationSeconds?: number;
  modelName?: string;
}

export type AudioTaskState = 'pending' | 'partial' | 'succeeded' | 'failed';

export interface AudioTaskStatus {
  taskId: string;
  state: AudioTaskState;
  vendorStatus: string;
  candidates: AudioCandidate[];
  errorCode?: number;
  errorMessage?: string;
}

export interface AudioGenerationSmokeTestResult {
  taskId: string;
  candidateCount: number;
  durationMs: number;
  fileSizeBytes: number;
  creditsBefore: number;
  creditsRemaining: number;
}

export interface AudioGenerationProvider {
  createMusic(request: MusicGenerationRequest): Promise<AudioTask>;
  createSound(request: SoundGenerationRequest): Promise<AudioTask>;
  getMusicTask(taskId: string): Promise<AudioTaskStatus>;
  getCredits(): Promise<number>;
}

export class AudioGenerationError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AudioGenerationError';
  }
}
