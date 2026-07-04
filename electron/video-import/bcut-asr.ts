import fs from 'node:fs/promises';
import type { TranscriptResult } from './types';

const API_BASE_URL = 'https://member.bilibili.com/x/bcut/rubick-interface';
const API_REQ_UPLOAD = `${API_BASE_URL}/resource/create`;
const API_COMMIT_UPLOAD = `${API_BASE_URL}/resource/create/complete`;
const API_CREATE_TASK = `${API_BASE_URL}/task`;
const API_QUERY_RESULT = `${API_BASE_URL}/task/result`;

const BCUT_HEADERS = {
  'User-Agent': 'Bilibili/1.0.0',
  'Content-Type': 'application/json',
};

export interface BcutAsrOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollLimit?: number;
  pollIntervalMs?: number;
}

interface BcutUploadInitResponse {
  data?: {
    in_boss_key?: string;
    resource_id?: string;
    upload_id?: string;
    upload_urls?: string[];
    per_size?: number;
  };
}

interface BcutCommitResponse {
  data?: {
    download_url?: string;
  };
}

interface BcutTaskResponse {
  data?: {
    task_id?: string;
  };
}

interface BcutQueryResponse {
  data?: {
    state?: number;
    result?: string;
  };
}

type BcutTaskPayload = {
  utterances?: Array<{
    transcript?: string;
    start_time?: number;
    end_time?: number;
    words?: Array<{
      label?: string;
      start_time?: number;
      end_time?: number;
    }>;
  }>;
};

const BCUT_FILE_TYPES = new Set(['flac', 'aac', 'm4a', 'mp3', 'wav']);

function resolveBcutFileType(audioPath: string): string {
  const ext = audioPath.split('.').pop()?.toLowerCase() ?? '';
  return BCUT_FILE_TYPES.has(ext) ? ext : 'mp3';
}

function msToSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

export function parseBcutResultPayload(payload: BcutTaskPayload): TranscriptResult {
  const segments = (payload.utterances ?? [])
    .map((item) => {
      const words = (item.words ?? [])
        .map((word) => ({
          text: String(word.label ?? '').trim(),
          startMs: Number(word.start_time ?? 0),
          endMs: Number(word.end_time ?? 0),
        }))
        .filter((word) => word.text.length > 0);
      return {
        text: String(item.transcript ?? '').trim(),
        startMs: Number(item.start_time ?? 0),
        endMs: Number(item.end_time ?? 0),
        ...(words.length > 0 ? { words } : {}),
      };
    })
    .filter((item) => item.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  const fullText = segments.map((item) => item.text).join('\n');
  const srtText = segments
    .map(
      (item, index) =>
        `${index + 1}\n${msToSrtTime(item.startMs)} --> ${msToSrtTime(item.endMs)}\n${item.text}\n`,
    )
    .join('\n')
    .trim();

  return {
    engine: 'bcut',
    fullText,
    srtText,
    segments,
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(input, init);
  if (!response.ok) {
    throw new Error(`Bcut 请求失败: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function uploadAudio(
  fetchImpl: typeof fetch,
  audioBuffer: Buffer,
  fileType: string,
): Promise<string> {
  const initResponse = await requestJson<BcutUploadInitResponse>(fetchImpl, API_REQ_UPLOAD, {
    method: 'POST',
    headers: BCUT_HEADERS,
    body: JSON.stringify({
      type: 2,
      name: `audio.${fileType}`,
      size: audioBuffer.length,
      ResourceFileType: fileType,
      model_id: '8',
    }),
  });

  const inBossKey = initResponse.data?.in_boss_key;
  const resourceId = initResponse.data?.resource_id;
  const uploadId = initResponse.data?.upload_id;
  const uploadUrls = initResponse.data?.upload_urls ?? [];
  const perSize = initResponse.data?.per_size ?? 0;

  if (!inBossKey || !resourceId || !uploadId || uploadUrls.length === 0 || !perSize) {
    throw new Error('Bcut 上传初始化失败');
  }

  const etags: string[] = [];
  for (let index = 0; index < uploadUrls.length; index += 1) {
    const start = index * perSize;
    const end = (index + 1) * perSize;
    const partResponse = await fetchImpl(uploadUrls[index], {
      method: 'PUT',
      headers: BCUT_HEADERS,
      body: new Uint8Array(audioBuffer.subarray(start, end)),
    });
    if (!partResponse.ok) {
      throw new Error(`Bcut 分片上传失败: ${partResponse.status}`);
    }
    const etag = partResponse.headers.get('Etag');
    if (etag) {
      etags.push(etag);
    }
  }

  const commitResponse = await requestJson<BcutCommitResponse>(fetchImpl, API_COMMIT_UPLOAD, {
    method: 'POST',
    headers: BCUT_HEADERS,
    body: JSON.stringify({
      InBossKey: inBossKey,
      ResourceId: resourceId,
      Etags: etags.join(','),
      UploadId: uploadId,
      model_id: '8',
    }),
  });

  const downloadUrl = commitResponse.data?.download_url;
  if (!downloadUrl) {
    throw new Error('Bcut 上传提交失败');
  }

  return downloadUrl;
}

async function createTask(
  fetchImpl: typeof fetch,
  downloadUrl: string,
): Promise<string> {
  const response = await requestJson<BcutTaskResponse>(fetchImpl, API_CREATE_TASK, {
    method: 'POST',
    headers: BCUT_HEADERS,
    body: JSON.stringify({
      resource: downloadUrl,
      model_id: '8',
    }),
  });

  const taskId = response.data?.task_id;
  if (!taskId) {
    throw new Error('Bcut 任务创建失败');
  }
  return taskId;
}

async function queryTaskResult(
  fetchImpl: typeof fetch,
  taskId: string,
): Promise<BcutQueryResponse['data']> {
  const url = `${API_QUERY_RESULT}?model_id=7&task_id=${encodeURIComponent(taskId)}`;
  const response = await requestJson<BcutQueryResponse>(fetchImpl, url, {
    method: 'GET',
    headers: BCUT_HEADERS,
  });
  return response.data;
}

export async function transcribeWithBcut(
  audioPath: string,
  options: BcutAsrOptions = {},
): Promise<TranscriptResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollLimit = options.pollLimit ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  const audioBuffer = await fs.readFile(audioPath);
  const downloadUrl = await uploadAudio(fetchImpl, audioBuffer, resolveBcutFileType(audioPath));
  const taskId = await createTask(fetchImpl, downloadUrl);

  for (let attempt = 0; attempt < pollLimit; attempt += 1) {
    const task = await queryTaskResult(fetchImpl, taskId);
    if (task?.state === 4) {
      const payload = typeof task.result === 'string'
        ? (JSON.parse(task.result) as BcutTaskPayload)
        : { utterances: [] };
      return parseBcutResultPayload(payload);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error('Bcut ASR 未在超时时间内完成');
}
