import { describe, expect, it } from 'vitest';
import { detectResumableAutoRun, listStartableSteps } from '../src/lib/auto-run-resume';
import { createDefaultProjectData, type ProjectData } from '../src/lib/project-persistence';
import type { TimelineData } from '../src/types';
import type { AIAnalysisResult, CoverCandidate } from '../src/types/ai';
import { createEmptyProductionState } from '../src/lib/director-workflow';

function makeTimeline(overrides: Partial<TimelineData> = {}): TimelineData {
  return {
    version: 2,
    fps: 30,
    width: 1080,
    height: 1920,
    podcast: { audioPath: '', srtPath: '', durationMs: 0 },
    tracks: [],
    overlays: [],
    subtitle: {} as TimelineData['subtitle'],
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectData> = {}): ProjectData {
  const base = createDefaultProjectData();
  return { ...base, ...overrides };
}

const FAKE_ANALYSIS: AIAnalysisResult = {
  cards: [],
  coverPrompts: [],
} as unknown as AIAnalysisResult;

const FAKE_COVER: CoverCandidate = {
  id: 'cover-1',
} as unknown as CoverCandidate;

describe('detectResumableAutoRun', () => {
  it('V3 导演检查点优先于旧时间线产物推断', () => {
    const production = createEmptyProductionState(1);
    production.workflow.stage = 'director-review';
    production.draftPlan = { revision: 2 } as never;
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿', originalContent: '有原稿',
      project: makeProject({ production }),
    });
    expect(result).toMatchObject({
      kind: 'resumable',
      checkpoint: 'director-review',
      nextStep: 'director_planning',
    });
  });

  it('V3 暂停态从 production_running 补缺失项', () => {
    const production = createEmptyProductionState(1);
    production.workflow.stage = 'production-paused';
    production.approvedPlan = { revision: 1, approvedAt: 1 } as never;
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿', originalContent: '有原稿',
      project: makeProject({ production }),
    });
    expect(result).toMatchObject({ kind: 'resumable', nextStep: 'production_running' });
  });

  it('V3 complete 不因旧产物缺失误报恢复', () => {
    const production = createEmptyProductionState(1);
    production.workflow.stage = 'complete';
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿', originalContent: '有原稿',
      project: makeProject({ production }),
    });
    expect(result.kind).toBe('none');
  });

  it('script.md 和 original.md 都为空时返回 none（从未启动）', () => {
    const result = detectResumableAutoRun({
      scriptContent: '',
      originalContent: '',
      project: makeProject(),
    });
    expect(result.kind).toBe('none');
  });

  it('两份文件只有空白内容时也返回 none', () => {
    const result = detectResumableAutoRun({
      scriptContent: '   \n\t  ',
      originalContent: '\t',
      project: makeProject(),
    });
    expect(result.kind).toBe('none');
  });

  it('有 original.md 但没 script.md → 从 script_generating 继续（写稿阶段中断）', () => {
    const result = detectResumableAutoRun({
      scriptContent: '',
      originalContent: '原始素材内容',
      project: makeProject(),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('script_generating');
      expect(result.nextStepLabel).toBe('撰写口播稿');
      expect(result.persistedAutoParams).toBeNull();
    }
  });

  it('有 original.md 但没 script.md 且 workflowMeta 有 autoParams → persistedAutoParams 非空', () => {
    const result = detectResumableAutoRun({
      scriptContent: '',
      originalContent: '原始素材',
      project: makeProject({
        workflowMeta: {
          lastAutoParams: {
            templateId: 't',
            roleId: 'r',
            voiceId: 'persisted-voice',
          },
          lastAutoRunAt: '2026-04-23T00:00:00.000Z',
        },
      }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('script_generating');
      expect(result.persistedAutoParams?.voiceId).toBe('persisted-voice');
    }
  });

  it('时间轴已含 AI 卡片 overlay 时视为完成，不恢复', () => {
    const timeline = makeTimeline({
      podcast: { audioPath: '/p/audio.mp3', srtPath: '/p/sub.srt', durationMs: 10000 },
      overlays: [
        {
          id: 'o1',
          type: 'image',
          assetPath: '',
          trackId: 'visual-2',
          startMs: 0,
          durationMs: 2000,
          position: { x: 0, y: 0, width: 1080, height: 1920 },
          overlayType: 'ai-card',
        } as unknown as TimelineData['overlays'][number],
      ],
    });
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({
        timeline,
        aiAnalysis: {
          analysisResult: FAKE_ANALYSIS,
          coverCandidates: [FAKE_COVER],
        },
      }),
    });
    expect(result.kind).toBe('none');
  });

  it('没有 audio/srt → 从 tts_generating 继续', () => {
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({ timeline: makeTimeline() }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('tts_generating');
      expect(result.nextStepLabel).toBe('语音合成');
    }
  });

  it('有 audio/srt 但无分析 → 从 ai_analyzing 继续', () => {
    const timeline = makeTimeline({
      podcast: { audioPath: '/p/audio.mp3', srtPath: '/p/sub.srt', durationMs: 10000 },
    });
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({ timeline }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('ai_analyzing');
    }
  });

  it('有分析但没封面 → 从 cover_generating 继续', () => {
    const timeline = makeTimeline({
      podcast: { audioPath: '/p/audio.mp3', srtPath: '/p/sub.srt', durationMs: 10000 },
    });
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({
        timeline,
        aiAnalysis: {
          analysisResult: FAKE_ANALYSIS,
          coverCandidates: [],
        },
      }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('cover_generating');
    }
  });

  it('有分析和封面但 timeline 无 AI 卡片 → 从 arranging 继续', () => {
    const timeline = makeTimeline({
      podcast: { audioPath: '/p/audio.mp3', srtPath: '/p/sub.srt', durationMs: 10000 },
    });
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({
        timeline,
        aiAnalysis: {
          analysisResult: FAKE_ANALYSIS,
          coverCandidates: [FAKE_COVER],
        },
      }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.nextStep).toBe('arranging');
    }
  });

  it('workflowMeta.lastAutoParams 存在时 persistedAutoParams 返回持久化值', () => {
    const project = makeProject({
      timeline: makeTimeline(),
      workflowMeta: {
        lastAutoParams: {
          templateId: 'persisted-template',
          roleId: 'persisted-role',
          voiceId: 'persisted-voice',
        },
        lastAutoRunAt: '2026-04-23T00:00:00.000Z',
      },
    });
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project,
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.persistedAutoParams?.voiceId).toBe('persisted-voice');
    }
  });

  it('workflowMeta 缺失时 persistedAutoParams 为 null', () => {
    const result = detectResumableAutoRun({
      scriptContent: '有口播稿',
      originalContent: '有原稿',
      project: makeProject({ timeline: makeTimeline() }),
    });
    expect(result.kind).toBe('resumable');
    if (result.kind === 'resumable') {
      expect(result.persistedAutoParams).toBeNull();
    }
  });
});

describe('listStartableSteps', () => {
  it('返回检测点及其之前的线性阶段', () => {
    expect(listStartableSteps('script_generating')).toEqual(['script_generating']);
    expect(listStartableSteps('tts_generating')).toEqual([
      'script_generating',
      'tts_generating',
    ]);
    expect(listStartableSteps('arranging')).toEqual([
      'script_generating',
      'tts_generating',
      'ai_analyzing',
      'cover_generating',
      'arranging',
    ]);
  });

  it('restart 时允许任意线性阶段', () => {
    expect(listStartableSteps('script_generating', { restart: true })).toHaveLength(5);
  });

  it('director 阶段不提供手动起点', () => {
    expect(listStartableSteps('director_planning')).toEqual([]);
    expect(listStartableSteps('production_running')).toEqual([]);
  });
});
