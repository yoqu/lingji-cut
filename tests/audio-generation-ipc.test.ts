import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/lingji-test') },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../electron/asset-library', () => ({
  importGeneratedMediaAsset: vi.fn(),
}));

import { pollSunoAudioTask } from '../electron/audio-generation-ipc';
import type { AudioTaskStatus } from '../src/lib/audio-gen/types';

function status(state: AudioTaskStatus['state'], vendorStatus: string): AudioTaskStatus {
  return { taskId: 'task-1', state, vendorStatus, candidates: [] };
}

describe('pollSunoAudioTask', () => {
  it('持续查询到 Sounds 任务完成', async () => {
    const getMusicTask = vi.fn()
      .mockResolvedValueOnce(status('pending', 'PENDING'))
      .mockResolvedValueOnce({
        ...status('succeeded', 'SUCCESS'),
        candidates: [{ id: 'audio-1', audioUrl: 'https://cdn.example/audio.mp3' }],
      });

    const result = await pollSunoAudioTask({
      provider: { getMusicTask },
      taskId: 'task-1',
      pollIntervalMs: 1,
      timeoutMs: 10_000,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.state).toBe('succeeded');
    expect(result.candidates).toHaveLength(1);
    expect(getMusicTask).toHaveBeenCalledTimes(2);
  });

  it('保留供应商失败信息', async () => {
    const failed = { ...status('failed', 'SENSITIVE_WORD_ERROR'), errorMessage: '敏感词' };
    await expect(pollSunoAudioTask({
      provider: { getMusicTask: vi.fn().mockResolvedValue(failed) },
      taskId: 'task-1',
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    })).rejects.toThrow('敏感词');
  });
});
