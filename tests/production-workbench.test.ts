import { describe, expect, it } from 'vitest';
import {
  audioRequestForCue,
  generationRequestForCue,
  restoreProductionWorkflow,
  updateProductionCue,
  updateShotAssetPrompt,
} from '../src/lib/production-workbench';
import { DEFAULT_AUDIO_PLAN, type MotionProductionPlan } from '../src/types/production';

function planFixture(): MotionProductionPlan {
  return {
    version: 2,
    motionBible: {
      visualThesis: '清晰克制',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: 'test', typographyUse: 'test' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    sequences: [],
    shots: [{
      id: 'shot-1', segmentId: 'seg-1', startMs: 0, endMs: 4_000,
      purpose: 'explain', carrier: 'image', intensity: 2, beats: [], audioCueIds: [],
      assetRequests: [{
        id: 'media-1', kind: 'image', role: 'background', query: '旧提示词',
        reusePolicy: 'prefer-library', constraints: { aspectRatio: '16:9' }, reuseKey: 'old',
      }],
    }],
    audioPlan: {
      ...DEFAULT_AUDIO_PLAN,
      bgm: [{
        id: 'bgm-main', role: 'bgm', query: '旧音乐提示词', startMs: 0,
        durationMs: 60_000, required: true, reuseKey: 'old-audio', loop: true,
      }],
    },
  };
}

describe('production workbench', () => {
  it('编辑声音提示词后重算 reuseKey 并清除过期素材绑定', () => {
    const next = updateProductionCue(planFixture(), 'bgm-main', {
      query: '新的克制知识播客配乐',
    });
    expect(next.audioPlan.bgm[0].query).toBe('新的克制知识播客配乐');
    expect(next.audioPlan.bgm[0].assetId).toBeUndefined();
    expect(next.audioPlan.bgm[0].reuseKey).toMatch(/^audio:bgm:/u);
    expect(next.audioPlan.bgm[0].reuseKey).not.toBe('old-audio');
  });

  it('选用素材后只更新 cue 的 assetId', () => {
    const next = updateProductionCue(planFixture(), 'bgm-main', { assetId: 'asset-1' });
    expect(next.audioPlan.bgm[0].assetId).toBe('asset-1');
    expect(next.audioPlan.bgm[0].reuseKey).toBe('old-audio');
  });

  it('编辑镜头素材提示词后同步重算素材 reuseKey', () => {
    const next = updateShotAssetPrompt(planFixture(), 'shot-1', 'media-1', '新的镜头提示词');
    expect(next.shots[0].assetRequests[0].query).toBe('新的镜头提示词');
    expect(next.shots[0].assetRequests[0].reuseKey).toMatch(/^image:background:/u);
  });

  it('把声音 cue 转换为 UI 可核对的 Suno V5 实际请求', () => {
    const request = generationRequestForCue(planFixture().audioPlan.bgm[0]);
    expect(request.music).toMatchObject({ model: 'V5', title: '播客主 BGM' });
    expect(request.music.negativeTags).toContain('spoken word');
    expect(request.sound.soundLoop).toBe(false);
  });

  it('为 BGM、stinger 与短音效生成可裁切的时长范围', () => {
    const bgm = audioRequestForCue(planFixture().audioPlan.bgm[0]);
    expect(bgm.constraints.durationRangeMs).toEqual([15_000, 60_000]);
    const stinger = audioRequestForCue({
      id: 'stinger-1', role: 'stinger', query: '章节声音', startMs: 0,
      durationMs: 3_000, required: false, reuseKey: 'stinger-key',
    });
    expect(stinger.constraints.durationRangeMs).toEqual([1_500, 4_000]);
    expect(stinger.constraints.transientType).toBe('chapter-stinger');
    const sfx = audioRequestForCue({
      id: 'sfx-1', role: 'sfx', query: '重点声音', startMs: 0,
      durationMs: 1_200, required: false, reuseKey: 'sfx-key',
    });
    expect(sfx.constraints.durationRangeMs).toEqual([200, 2_000]);
    expect(sfx.constraints.transientType).toBe('impact');
  });

  it('旧制作计划按项目保存的导演模式恢复到 Animatic 确认', () => {
    const next = restoreProductionWorkflow(planFixture(), 'director', true);
    expect(next.workflow).toMatchObject({ mode: 'director', stage: 'animatic-review' });
  });
});
