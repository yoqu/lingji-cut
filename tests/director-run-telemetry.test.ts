import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirectorPlan } from '../src/types/director';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  makeMainTelemetry: vi.fn(),
  runShowDirectorAgent: vi.fn(),
  loadProjectFile: vi.fn(),
  mutateProjectProduction: vi.fn(),
  loadFullHeadlessAISettings: vi.fn(),
  loadHeadlessProjectBindings: vi.fn(),
  loadEffectivePromptTemplate: vi.fn(),
}));

vi.mock('../electron/telemetry/main-telemetry', () => ({
  makeMainTelemetry: mocks.makeMainTelemetry,
}));
vi.mock('../electron/director-agent/show-director-run', () => ({
  runShowDirectorAgent: mocks.runShowDirectorAgent,
}));
vi.mock('../electron/project-file', () => ({
  loadProjectFile: mocks.loadProjectFile,
  mutateProjectProduction: mocks.mutateProjectProduction,
}));
vi.mock('../electron/pipeline/headless-settings', () => ({
  loadFullHeadlessAISettings: mocks.loadFullHeadlessAISettings,
  loadHeadlessProjectBindings: mocks.loadHeadlessProjectBindings,
}));
vi.mock('../electron/prompts-io', () => ({
  loadEffectivePromptTemplate: mocks.loadEffectivePromptTemplate,
}));
vi.mock('../electron/runtime-binaries', () => ({
  resolveFfmpegPath: () => '/safe/ffmpeg',
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/safe/app' },
}));

import { runDirectorPlanHeadless } from '../electron/pipeline/runs/director-run';

const tempDirs: string[] = [];
const NOW = 1_775_000_000_000;

function projectDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-director-telemetry-'));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, 'podcast-subtitles.srt'),
    '1\n00:00:00,000 --> 00:00:02,000\n测试字幕\n',
  );
  return dir;
}

function plan(): DirectorPlan {
  return {
    revision: 1,
    segments: [
      { renderStrategy: 'agent-composite', strategyStatus: 'ready' },
      { renderStrategy: 'motion-card', strategyStatus: 'blocked' },
    ],
  } as unknown as DirectorPlan;
}

function context(dir: string) {
  return {
    projectPath: dir,
    userDataPath: '/safe/user-data',
    params: { mode: 'director', globalPrompt: '只用于模型，不得进入日志' },
    handle: {
      taskId: 'abcdef1234567890',
      signal: new AbortController().signal,
      update: vi.fn(),
      log: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.makeMainTelemetry.mockReturnValue({ emit: mocks.emit });
  mocks.loadProjectFile.mockResolvedValue({ production: undefined });
  mocks.mutateProjectProduction.mockResolvedValue(undefined);
  mocks.loadFullHeadlessAISettings.mockResolvedValue({});
  mocks.loadHeadlessProjectBindings.mockResolvedValue(null);
  mocks.loadEffectivePromptTemplate.mockResolvedValue({ system: '', user: '' });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runDirectorPlanHeadless telemetry', () => {
  it('creates a headless director run and forwards only safe agent metadata', async () => {
    const dir = projectDir();
    mocks.runShowDirectorAgent.mockImplementation(async (options) => {
      options.telemetry?.emit('director.agent.tool', {
        name: 'director_search_materials',
        kind: 'video',
      });
      options.telemetry?.emit('director.agent.tool-result', {
        name: 'director_search_materials',
        ok: false,
        outcome: 'retryable-error',
        candidateCount: 0,
        errorCount: 1,
        durationMs: 15_001,
        error: 'SUPER-SECRET token=abc123',
      });
      options.telemetry?.emit('director.agent.turn', {
        completionTurn: 2,
        modelRound: 7,
        stopReason: 'length',
        inputTokens: 1200,
        outputTokens: 340,
        contextTokens: 1800,
        assistantChars: 800,
        thinkingChars: 450,
        assistantText: 'SUPER-SECRET assistant body',
      });
      options.telemetry?.emit('director.agent.checkpoint', {
        completionTurn: 2,
        workingVersion: 4,
        segmentCount: 8,
        firstEntryIndex: 1,
        lastEntryIndex: 9,
        expectedEntryCount: 12,
        candidateCount: 16,
        inspectedCandidateCount: 2,
        initialized: true,
        validated: false,
      });
      options.telemetry?.emit('director.agent.end', {
        ok: true,
        durationMs: 120,
        toolCalls: 5,
        error: 'SUPER-SECRET token=abc123',
        prompt: 'SUPER-SECRET prompt',
        path: dir,
        image: 'data:image/png;base64,SUPER-SECRET',
      });
      return plan();
    });

    await expect(runDirectorPlanHeadless(context(dir) as never)).resolves.toMatchObject({ revision: 1 });

    expect(mocks.makeMainTelemetry).toHaveBeenCalledWith(`director-${NOW}-abcdef12`);
    expect(mocks.runShowDirectorAgent).toHaveBeenCalledWith(expect.objectContaining({
      telemetry: expect.objectContaining({ emit: expect.any(Function) }),
    }));
    expect(mocks.emit).toHaveBeenCalledWith('run.start', {
      stage: 'director.plan',
      source: 'headless',
      mode: 'director',
    });
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.end', {
      ok: true,
      durationMs: 120,
      toolCalls: 5,
    });
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.tool', {
      name: 'director_search_materials',
      materialKind: 'video',
    });
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.tool-result', {
      name: 'director_search_materials',
      ok: false,
      outcome: 'retryable-error',
      candidateCount: 0,
      errorCount: 1,
      durationMs: 15_001,
    });
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.turn', {
      completionTurn: 2,
      modelRound: 7,
      stopReason: 'length',
      inputTokens: 1200,
      outputTokens: 340,
      contextTokens: 1800,
      assistantChars: 800,
      thinkingChars: 450,
    });
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.checkpoint', {
      completionTurn: 2,
      workingVersion: 4,
      segmentCount: 8,
      firstEntryIndex: 1,
      lastEntryIndex: 9,
      expectedEntryCount: 12,
      candidateCount: 16,
      inspectedCandidateCount: 2,
      initialized: true,
      validated: false,
    });
    const materialEvent = mocks.emit.mock.calls.find(([kind]) => kind === 'director.agent.tool');
    expect(materialEvent?.[1]).not.toHaveProperty('kind');
    expect(mocks.emit.mock.calls.some(([kind]) => kind === 'video')).toBe(false);
    expect(mocks.emit).toHaveBeenCalledWith('run.end', expect.objectContaining({
      stage: 'director.plan',
      source: 'headless',
      mode: 'director',
      ok: true,
      revision: 1,
      segmentCount: 2,
      compositeCount: 1,
      blockedCount: 1,
    }));
    const logged = JSON.stringify(mocks.emit.mock.calls);
    expect(logged).not.toContain('SUPER-SECRET');
    expect(logged).not.toContain(dir);
    expect(logged).not.toContain('data:image');
  });

  it('keeps all reported progress percentages monotonic across callback regressions', async () => {
    const dir = projectDir();
    const ctx = context(dir);
    mocks.runShowDirectorAgent.mockImplementation(async (options) => {
      options.onProgress?.('planning', 80);
      options.onProgress?.('planning', 20);
      options.onProgress?.('motion-bible', 80);
      options.onProgress?.('motion-bible', 10);
      options.onProgress?.('planning', 100);
      return plan();
    });

    await runDirectorPlanHeadless(ctx as never);

    const updates = ctx.handle.update.mock.calls.map(([update]) => update as {
      phase: string;
      percent: number;
    });
    expect(updates.map(({ percent }) => percent)).toEqual([
      5,
      15,
      59,
      59,
      90,
      90,
      90,
      100,
    ]);
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index].percent).toBeGreaterThanOrEqual(updates[index - 1].percent);
    }
  });

  it('emits one safe run.end event when planning fails', async () => {
    const dir = projectDir();
    const error = Object.assign(
      new Error(`failed at ${dir}; token=SUPER-SECRET; data:image/png;base64,SUPER-SECRET`),
      { code: 'director_failed' },
    );
    mocks.runShowDirectorAgent.mockImplementation(async (options) => {
      options.telemetry?.emit('director.agent.end', {
        ok: false,
        durationMs: 80,
        error: error.message,
      });
      throw error;
    });

    await expect(runDirectorPlanHeadless(context(dir) as never)).rejects.toBe(error);

    const runEnds = mocks.emit.mock.calls.filter(([kind]) => kind === 'run.end');
    expect(runEnds).toEqual([[
      'run.end',
      expect.objectContaining({
        stage: 'director.plan',
        source: 'headless',
        mode: 'director',
        ok: false,
        revision: 1,
        errorName: 'Error',
        errorCode: 'director_failed',
      }),
    ]]);
    expect(mocks.emit).toHaveBeenCalledWith('director.agent.end', {
      ok: false,
      durationMs: 80,
    });
    const logged = JSON.stringify(mocks.emit.mock.calls);
    expect(logged).not.toContain('SUPER-SECRET');
    expect(logged).not.toContain(dir);
    expect(logged).not.toContain('data:image');
  });
});
