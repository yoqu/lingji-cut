import { describe, expect, it } from 'vitest';
import {
  AgentCompositeStoryboardRegenerationError,
  ApprovedDirectorSegmentMismatchError,
  requireApprovedAnimationDirectionContext,
  requireApprovedCardRegenerationContext,
  requireExactApprovedDirectorSegment,
} from '../src/lib/director-regeneration-context';
import { createEmptyProductionState } from '../src/lib/director-workflow';

const SEGMENT_ID = 'seg-approved';

function approvedProduction() {
  const production = createEmptyProductionState(1);
  const compositionIntent = {
    narrativeGoal: '让真实生产画面和核心结论形成因果关系',
    focalPriority: '先看生产主体，再看核心结论',
    temporalRelationship: '素材先建立事实，图形随后完成解释',
    mustShow: ['生产主体', '核心结论'],
    avoid: ['纯文字卡'],
  };
  const persistedInput = {
    segmentIndex: 0,
    segmentId: SEGMENT_ID,
    startMs: 0,
    durationMs: 1_000,
    usage: 'required' as const,
    trimStartMs: 240,
    fileFingerprint: 'stat:100:200',
    asset: {
      id: 'asset-persisted',
      filename: 'persisted.mp4',
      path: '/library/persisted.mp4',
      kind: 'video' as const,
      score: 0.98,
    },
  };
  const optionalInput = {
    ...persistedInput,
    usage: 'optional' as const,
    trimStartMs: 0,
    fileFingerprint: 'stat:300:400',
    asset: {
      ...persistedInput.asset,
      id: 'asset-optional',
      filename: 'optional.png',
      path: '/library/optional.png',
      kind: 'image' as const,
    },
  };
  production.approvedPlan = {
    revision: 1,
    inputFingerprint: 'director-approved',
    approvedAt: 10,
    segments: [{
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 0,
      endMs: 1_000,
      enabled: true,
      purpose: 'evidence',
      carrier: 'media-window',
      intensity: 2,
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      compositionIntent,
      compositionAssets: [
        {
          asset: persistedInput.asset,
          usage: 'required',
          trimStartMs: persistedInput.trimStartMs,
        },
        {
          asset: optionalInput.asset,
          usage: 'optional',
          trimStartMs: optionalInput.trimStartMs,
        },
      ],
      fallbackPolicy: 'block',
      rationale: '素材和信息层缺一不可',
    }],
  } as never;
  production.footage = {
    placements: [],
    compositionInputs: [
      persistedInput,
      optionalInput,
      {
        ...persistedInput,
        segmentId: 'other-segment',
        asset: { ...persistedInput.asset, id: 'asset-other' },
      },
    ],
    claimedSegmentIds: [],
    fallbacks: [],
    generationProvenance: {
      directorRevision: 1,
      fingerprint: 'footage-director-approved-1',
      generatedAt: 10,
    },
  } as never;
  production.outputs.footage = {
    status: 'current',
    directorRevision: 1,
    updatedAt: 10,
  };
  return { production, compositionIntent, persistedInput, optionalInput };
}

describe('requireApprovedCardRegenerationContext', () => {
  it('allows a standard Motion card to generate with an explicit empty input list before footage staging', () => {
    const { production } = approvedProduction();
    production.approvedPlan!.segments[0] = {
      ...production.approvedPlan!.segments[0],
      visualType: 'motion',
      renderStrategy: 'motion-card',
      compositionIntent: undefined,
      compositionAssets: [],
      fallbackPolicy: 'block',
    };
    production.footage = undefined;
    production.outputs.footage = {
      status: 'generating',
      directorRevision: 1,
      updatedAt: 20,
    };

    expect(requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [],
    })).toEqual({
      renderStrategy: 'motion-card',
      compositionIntent: undefined,
      compositionInputs: [],
      fallbackPolicy: 'block',
    });
  });

  it('backfills a missing card request contract from the exact approved segment', () => {
    const { production, compositionIntent, persistedInput, optionalInput } = approvedProduction();

    expect(requireApprovedCardRegenerationContext(production, SEGMENT_ID)).toEqual({
      renderStrategy: 'agent-composite',
      compositionIntent,
      compositionInputs: [persistedInput, optionalInput],
      fallbackPolicy: 'block',
    });
  });

  it('accepts a current frozen required input while allowing the approved optional input to be omitted', () => {
    const { production, compositionIntent, persistedInput } = approvedProduction();
    const freshInput = {
      ...persistedInput,
      asset: { ...persistedInput.asset, filename: 'fresh.mp4' },
    };

    expect(requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [freshInput],
    })).toEqual({
      renderStrategy: 'agent-composite',
      compositionIntent,
      compositionInputs: [freshInput],
      fallbackPolicy: 'block',
    });
  });

  it('rejects caller-provided inputs while the approved footage output is not current', () => {
    const { production, persistedInput } = approvedProduction();
    production.outputs.footage = { status: 'generating', directorRevision: 1, updatedAt: 20 };

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [{
        ...persistedInput,
        fileFingerprint: 'stat:500:600',
      }],
    })).toThrow('当前导演版本的素材产物尚未就绪');
  });

  it.each(['stale', 'failed'] as const)(
    'rejects caller-provided inputs when the footage output is %s',
    (status) => {
      const { production, persistedInput } = approvedProduction();
      production.outputs.footage.status = status;

      expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
        compositionInputs: [persistedInput],
      })).toThrow('当前导演版本的素材产物尚未就绪');
    },
  );

  it('rejects caller-provided inputs when footage provenance is missing', () => {
    const { production, persistedInput } = approvedProduction();
    production.footage!.generationProvenance = undefined;

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [persistedInput],
    })).toThrow('当前导演版本的素材产物尚未就绪');
  });

  it('does not reuse footage inputs unless output revision and provenance are current', () => {
    const { production } = approvedProduction();
    const mutations = [
      () => { production.outputs.footage.status = 'stale'; },
      () => { production.outputs.footage.directorRevision = 2; },
      () => { production.footage!.generationProvenance!.directorRevision = 2; },
      () => { production.footage!.generationProvenance!.fingerprint = 'footage-other-1'; },
    ];

    for (const mutate of mutations) {
      const { production: candidate } = approvedProduction();
      Object.assign(production, candidate);
      mutate();
      expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID))
        .toThrow('当前导演版本的素材产物尚未就绪');
    }
  });

  it('rejects clearing or omitting a required approved composition asset', () => {
    const { production, optionalInput } = approvedProduction();

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [],
    })).toThrow('必用组合素材 asset-persisted 未包含');
    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [optionalInput],
    })).toThrow('必用组合素材 asset-persisted 未包含');
  });

  it('does not let fresh inputs repair a current artifact that has no frozen reference', () => {
    const { production, persistedInput } = approvedProduction();
    production.footage!.compositionInputs = [];

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [persistedInput],
    })).toThrow('组合素材 asset-persisted 不在已批准素材绑定中');
  });

  it.each([
    ['asset path', (input: ReturnType<typeof approvedProduction>['persistedInput']) => ({
      ...input,
      asset: { ...input.asset, path: '/library/replaced.mp4' },
    })],
    ['trim', (input: ReturnType<typeof approvedProduction>['persistedInput']) => ({
      ...input,
      trimStartMs: input.trimStartMs + 1,
    })],
    ['start time', (input: ReturnType<typeof approvedProduction>['persistedInput']) => ({
      ...input,
      startMs: input.startMs + 1,
    })],
    ['duration', (input: ReturnType<typeof approvedProduction>['persistedInput']) => ({
      ...input,
      durationMs: input.durationMs + 1,
    })],
    ['fingerprint', (input: ReturnType<typeof approvedProduction>['persistedInput']) => ({
      ...input,
      fileFingerprint: 'stat:changed:999',
    })],
  ])('rejects fresh composition inputs with mismatched %s', (_label, mutate) => {
    const { production, persistedInput } = approvedProduction();

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [mutate(persistedInput)],
    })).toThrow(ApprovedDirectorSegmentMismatchError);
  });

  it('rejects unfrozen fresh inputs even when the approved asset identity matches', () => {
    const { production, persistedInput } = approvedProduction();

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      compositionInputs: [{ ...persistedInput, fileFingerprint: undefined }],
    })).toThrow('缺少冻结文件指纹');
  });

  it('rejects attempts to override an approved strategy or fallback policy', () => {
    const { production } = approvedProduction();

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      fallbackPolicy: 'motion',
    })).toThrow('重生成请求试图覆盖已批准失败退路');
    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      renderStrategy: 'motion-card',
    })).toThrow('重生成请求试图覆盖已批准执行策略');
  });

  it('allows only the explicit empty-input motion fallback approved for an Agent Composite', () => {
    const { production, compositionIntent } = approvedProduction();
    production.approvedPlan!.segments[0].fallbackPolicy = 'motion';

    expect(requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      renderStrategy: 'motion-card',
      compositionIntent,
      compositionInputs: [],
      fallbackPolicy: 'block',
      approvedFallbackExecution: 'motion',
    })).toEqual({
      renderStrategy: 'motion-card',
      compositionIntent,
      compositionInputs: [],
      fallbackPolicy: 'block',
    });
  });

  it('rejects a claimed approved motion fallback unless policy, inputs, and one-shot fallback match', () => {
    const { production, persistedInput } = approvedProduction();
    const request = {
      renderStrategy: 'motion-card' as const,
      compositionInputs: [],
      fallbackPolicy: 'block' as const,
      approvedFallbackExecution: 'motion' as const,
    };

    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, request))
      .toThrow('执行退路与已批准的 Agent 合成 motion 退路不一致');

    production.approvedPlan!.segments[0].fallbackPolicy = 'motion';
    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      ...request,
      compositionInputs: [persistedInput],
    })).toThrow('执行退路与已批准的 Agent 合成 motion 退路不一致');
    expect(() => requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
      ...request,
      fallbackPolicy: 'motion',
    })).toThrow('执行退路与已批准的 Agent 合成 motion 退路不一致');
  });

  it('rejects a card segment that is absent from the approved plan', () => {
    const { production } = approvedProduction();

    expect(() => requireApprovedCardRegenerationContext(production, 'seg-stale'))
      .toThrow(ApprovedDirectorSegmentMismatchError);
    expect(() => requireApprovedCardRegenerationContext(production, 'seg-stale'))
      .toThrow('已批准导演方案中不存在镜头 seg-stale');
  });

  it('rejects fresh composition inputs owned by another segment', () => {
    const { production, persistedInput } = approvedProduction();

    try {
      requireApprovedCardRegenerationContext(production, SEGMENT_ID, {
        compositionInputs: [{ ...persistedInput, segmentId: 'seg-other' }],
      });
      throw new Error('expected mismatch error');
    } catch (error) {
      expect(error).toMatchObject({ code: 'approved_director_segment_mismatch' });
      expect(error).toHaveProperty('message', expect.stringContaining('组合素材属于镜头 seg-other'));
    }
  });
});

describe('requireExactApprovedDirectorSegment', () => {
  it('returns the canonical approved segment for an exact request', () => {
    const { production } = approvedProduction();

    expect(requireExactApprovedDirectorSegment(production, {
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 0,
      endMs: 1_000,
    })).toMatchObject({
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 0,
      endMs: 1_000,
    });
  });

  it('rejects a same-id request with different timecodes', () => {
    const { production } = approvedProduction();

    expect(() => requireExactApprovedDirectorSegment(production, {
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 1,
      endMs: 1_000,
    })).toThrow('请求时间码与已批准镜头不一致');
  });

  it('rejects a same-id request with stale director content', () => {
    const { production } = approvedProduction();

    expect(() => requireExactApprovedDirectorSegment(production, {
      id: SEGMENT_ID,
      title: '分析阶段旧标题',
      summary: '分析阶段旧摘要',
      startMs: 0,
      endMs: 1_000,
    })).toThrow('请求内容与已批准镜头不一致');
  });

  it('blocks the legacy one-shot storyboard endpoint for an approved agent composite', () => {
    const { production } = approvedProduction();

    expect(() => requireApprovedAnimationDirectionContext(production, {
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 0,
      endMs: 1_000,
    })).toThrow(AgentCompositeStoryboardRegenerationError);
    expect(() => requireApprovedAnimationDirectionContext(production, {
      id: SEGMENT_ID,
      title: '批准镜头',
      summary: '摘要',
      startMs: 0,
      endMs: 1_000,
    })).toThrow('必须由 Pi Agent 整体重生成或精雕');
  });
});
