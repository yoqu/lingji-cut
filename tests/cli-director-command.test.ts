import { describe, expect, it } from 'vitest';
import { runDirectorCommand } from '../cli/src/commands/director';
import type { ToolCaller } from '../cli/src/client';
import { createDefaultTimeline, createVisualTrack } from '../src/types';
import { buildAICardTimelineDraft, DEFAULT_CARD_STYLE, type AICard } from '../src/types/ai';
import type { DirectorPlan } from '../src/types/director';
import { buildHeadlessDirectorTimeline } from '../electron/pipeline/director-headless-timeline';

function fake() {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      return name === 'lingji_get_active_project' ? { projectPath: '/p' } : { taskId: 'task-1' };
    },
    async close() {},
  };
  return { calls, client };
}

describe('runDirectorCommand', () => {
  it('plan forwards prompt and project to lingji_director_plan', async () => {
    const { calls, client } = fake();
    await runDirectorCommand('plan', { prompt: '克制的科技感' }, client);
    expect(calls.at(-1)).toEqual({
      name: 'lingji_director_plan',
      args: { projectPath: '/p', globalPrompt: '克制的科技感' },
    });
  });

  it('status reads the director production state', async () => {
    const { calls, client } = fake();
    await runDirectorCommand('status', { project: '/project' }, client);
    expect(calls.at(-1)).toEqual({
      name: 'lingji_director_status',
      args: { projectPath: '/project' },
    });
  });

  it('approve forwards an optional optimistic revision', async () => {
    const { calls, client } = fake();
    await runDirectorCommand('approve', { project: '/p', revision: '3' }, client);
    expect(calls.at(-1)).toEqual({
      name: 'lingji_director_approve',
      args: { projectPath: '/p', revision: 3 },
    });
  });

  it('rejects invalid revisions before calling the service', async () => {
    const { client } = fake();
    await expect(runDirectorCommand('approve', { revision: '0' }, client)).rejects.toMatchObject({
      code: 'bad_args',
    });
  });

  it('preserves stable overlay identity and position during atomic timeline replacement', () => {
    const timeline = createDefaultTimeline();
    timeline.tracks.push(createVisualTrack(2, 2));
    const card: AICard = {
      id: 'card-1', segmentId: 'seg-1', type: 'motion', title: '旧标题', content: '内容',
      startMs: 0, endMs: 5_000, displayDurationMs: 5_000, displayMode: 'fullscreen',
      template: 'default', enabled: true, style: DEFAULT_CARD_STYLE.motion,
    };
    const draft = buildAICardTimelineDraft(card);
    const position = { x: 11, y: 22, width: 333, height: 444 };
    timeline.overlays.push({
      id: 'overlay-stable', type: 'image', assetPath: '', trackId: 'visual-2',
      startMs: 0, durationMs: 5_000, position,
      overlayType: 'ai-card', aiCardData: draft.aiCardData,
    });
    const result = buildHeadlessDirectorTimeline({
      current: timeline,
      analysis: {
        segments: [], cards: [{ ...card, title: '新标题', startMs: 1_000, endMs: 6_000 }],
        coverPrompts: [], summary: '摘要', keywords: [],
      },
      plan: {
        segments: [],
        motionBible: {
          visualThesis: '测试',
          rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
          carrierPlan: [],
          styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
          transitionRules: { default: 'crossfade', matchCutCandidates: [] },
        },
      } as DirectorPlan,
      highlights: [], audioPlacements: [],
    });
    const overlay = result.overlays.find((item) => item.overlayType === 'ai-card')!;
    expect(overlay).toMatchObject({ id: 'overlay-stable', position, startMs: 1_000 });
    expect(overlay.aiCardData?.title).toBe('新标题');
  });
});
