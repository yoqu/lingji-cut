import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runRegenerateCard,
  runRegenerateCardMedia,
  runConvertCard,
  runSculptCard,
} from '../electron/pipeline/runs/card-run';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { createDefaultTimeline } from '../src/types';

function project(card: unknown, segment: unknown, production?: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-cr-'));
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 1,
      createdAt: 'x',
      updatedAt: 'x',
      timeline: null,
      aiAnalysis: {
        analysisResult: {
          segments: [segment],
          cards: [card],
          coverPrompts: [],
          summary: 'S',
          keywords: ['k'],
        },
        coverCandidates: [],
      },
      script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
      ...(production ? { production } : {}),
    }),
  );
  writeFileSync(
    path.join(dir, 'podcast-subtitles.srt'),
    '1\n00:00:00,000 --> 00:00:01,000\n你好\n',
  );
  return dir;
}

const ud = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lingji-crud-'));
  writeFileSync(
    path.join(d, 'settings.json'),
    JSON.stringify({
      aiSettings: {
        llmProviders: [
          { id: 'l1', name: 'x', type: 'openai_compatible', baseUrl: 'h', apiKey: 'k', models: ['m'] },
        ],
        defaultProviderId: 'l1',
        defaultModel: 'm',
      },
    }),
  );
  return d;
};

const handle = () => ({
  taskId: 't',
  signal: new AbortController().signal,
  update: () => {},
  log: () => {},
});

const SEG = { id: 's1', title: '段', summary: '摘要', startMs: 0, endMs: 1000 };
const CARD = {
  id: 'c1',
  segmentId: 's1',
  type: 'summary',
  title: 'T',
  content: '内容',
  startMs: 0,
  endMs: 1000,
  displayDurationMs: 1000,
  displayMode: 'pip',
  template: 'default',
  enabled: true,
  style: {},
};

describe('runRegenerateCard', () => {
  it('regenerates a card and persists, preserving id', async () => {
    const dir = project(CARD, SEG);
    const u = ud();
    try {
      const res = await runRegenerateCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        { regenerate: async (_e, card) => ({ ...card, title: '重生成后' }) as never },
      );
      expect((res as { title: string }).title).toBe('重生成后');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].title).toBe('重生成后');
      expect(saved.aiAnalysis.analysisResult.cards[0].id).toBe('c1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('loads cards.animation template without passing the previous storyboard to regeneration', async () => {
    const motionCard = { ...CARD, type: 'summary', animationDirection: '逐拍：先标题后正文' };
    const dir = project(motionCard, SEG);
    const u = ud();
    try {
      let captured: Record<string, unknown> | undefined;
      await runRegenerateCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card, _approvedSegment, _set, opts) => {
            captured = opts;
            return { ...card } as never;
          },
        },
      );
      expect(captured).toBeDefined();
      expect((captured!.animationTemplate as { name?: string } | undefined)?.name).toBe(
        'cards.animation',
      );
      expect(captured!.animationDirection).toBeUndefined();
      expect(captured!.refineExistingMotion).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('restores the approved agent-composite contract and frozen media inputs', async () => {
    const production = createEmptyProductionState(1);
    const compositionIntent = {
      narrativeGoal: '用真实产品画面承载结论',
      focalPriority: '产品主体优先',
      temporalRelationship: '先素材后观点',
      mustShow: ['产品主体', '核心结论'],
      avoid: ['纯文字卡'],
    };
    const compositionInput = {
      segmentIndex: 0,
      segmentId: 's1',
      startMs: 0,
      durationMs: 1_000,
      usage: 'required',
      trimStartMs: 0,
      fileFingerprint: 'stat:100:200',
      asset: {
        id: 'asset-1',
        filename: 'asset.mp4',
        path: '/library/asset.mp4',
        kind: 'video',
        score: 0.99,
      },
    };
    production.approvedPlan = {
      revision: 2,
      inputFingerprint: 'director-card-run',
      approvedAt: 2,
      segments: [{
        ...SEG,
        enabled: true,
        purpose: 'evidence',
        carrier: 'media-window',
        intensity: 2,
        visualType: 'image',
        renderStrategy: 'agent-composite',
        compositionIntent,
        compositionAssets: [{
          asset: compositionInput.asset,
          usage: 'required',
          trimStartMs: 0,
        }],
        fallbackPolicy: 'block',
        rationale: '真实素材与图形解释缺一不可',
      }],
    } as never;
    production.footage = {
      placements: [],
      compositionInputs: [
        compositionInput,
        { ...compositionInput, segmentId: 'other', asset: { ...compositionInput.asset, id: 'other' } },
      ],
      claimedSegmentIds: [],
      fallbacks: [],
      generationProvenance: {
        directorRevision: 2,
        fingerprint: 'footage-director-card-run-2',
        generatedAt: 2,
      },
    } as never;
    production.outputs.footage = {
      status: 'current',
      directorRevision: 2,
      updatedAt: 2,
    };
    const dir = project(CARD, SEG, production);
    const u = ud();
    try {
      let captured: Record<string, unknown> | undefined;
      let capturedSegment: Record<string, unknown> | undefined;
      await runRegenerateCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card, approvedSegment, _set, opts) => {
            captured = opts;
            capturedSegment = approvedSegment as unknown as Record<string, unknown>;
            return { ...card } as never;
          },
        },
      );

      expect(captured).toMatchObject({
        renderStrategy: 'agent-composite',
        compositionIntent,
        fallbackPolicy: 'block',
      });
      expect(captured?.compositionInputs).toEqual([compositionInput]);
      expect(capturedSegment).toMatchObject({
        id: 's1',
        title: '段',
        rationale: '真实素材与图形解释缺一不可',
        renderStrategy: 'agent-composite',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('stops regeneration when the card segment is absent from the approved plan', async () => {
    const production = createEmptyProductionState(1);
    production.approvedPlan = {
      revision: 2,
      approvedAt: 2,
      segments: [{
        ...SEG,
        id: 'approved-other',
        enabled: true,
        purpose: 'explain',
        carrier: 'data-hero',
        intensity: 1,
        renderStrategy: 'motion-card',
        rationale: '测试批准镜头',
      }],
    } as never;
    const dir = project(CARD, SEG, production);
    const u = ud();
    let regenerateCalled = false;
    try {
      await expect(runRegenerateCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card) => {
            regenerateCalled = true;
            return card;
          },
        },
      )).rejects.toMatchObject({ code: 'approved_director_segment_mismatch' });
      expect(regenerateCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('rejects a stale analysis segment time range instead of regenerating with it', async () => {
    const production = createEmptyProductionState(1);
    production.approvedPlan = {
      revision: 2,
      inputFingerprint: 'director-stale-segment',
      approvedAt: 2,
      segments: [{
        ...SEG,
        endMs: 2_000,
        enabled: true,
        purpose: 'explain',
        carrier: 'data-hero',
        intensity: 1,
        renderStrategy: 'motion-card',
        rationale: '批准时间范围',
      }],
    } as never;
    const dir = project(CARD, SEG, production);
    const u = ud();
    let regenerateCalled = false;
    try {
      await expect(runRegenerateCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card) => {
            regenerateCalled = true;
            return card;
          },
        },
      )).rejects.toThrow('请求时间码与已批准镜头不一致');
      expect(regenerateCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('throws card_not_found for missing card', async () => {
    const dir = project(CARD, SEG);
    const u = ud();
    try {
      await expect(
        runRegenerateCard(
          { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'zzz' } },
          { regenerate: async () => ({}) as never },
        ),
      ).rejects.toMatchObject({ code: 'card_not_found' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runSculptCard', () => {
  it('explicitly enables the previous storyboard and source only for refine mode', async () => {
    const motionCard = {
      ...CARD,
      type: 'summary',
      animationDirection: '逐拍：先标题后正文',
      motionCard: {
        tsx: 'export default function Card(){ return null; }',
        compiledAt: 1,
        prompt: '',
        retryCount: 0,
      },
    };
    const dir = project(motionCard, SEG);
    const u = ud();
    try {
      let captured: Record<string, unknown> | undefined;
      await runSculptCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card, _s, _set, opts) => {
            captured = opts;
            return { ...card } as never;
          },
        },
      );
      expect(captured?.refineExistingMotion).toBe(true);
      expect(captured?.reuseStoryboardDraft).toBe(true);
      expect(captured?.animationDirection).toBe('逐拍：先标题后正文');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('persists a regenerated placed card to both AI analysis and its timeline overlay', async () => {
    const motionCard = {
      ...CARD,
      type: 'summary',
      renderMode: 'motion-card',
      animationDirection: '{"claim":"old"}',
      assetBindings: [],
      motionCard: {
        tsx: 'export default function Old(){ return null; }',
        compiledAt: 1,
        prompt: '',
        retryCount: 0,
      },
    };
    const dir = project(motionCard, SEG);
    const u = ud();
    try {
      const file = path.join(dir, 'project.json');
      const saved = JSON.parse(readFileSync(file, 'utf-8'));
      const timeline = createDefaultTimeline();
      timeline.overlays.push({
        id: 'overlay-1',
        type: 'image',
        assetPath: '',
        trackId: 'visual-2',
        startMs: 0,
        durationMs: 1_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        overlayType: 'ai-card',
        aiCardData: {
          sourceCardId: 'c1',
          cardType: 'summary',
          title: 'old',
          content: 'old',
          template: 'default',
          displayMode: 'pip',
          style: {},
          renderMode: 'motion-card',
        },
      });
      saved.timeline = timeline;
      writeFileSync(file, JSON.stringify(saved));

      await runSculptCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          regenerate: async (_e, card) => ({
            ...card,
            title: 'new',
            animationDirection: '{"claim":"new"}',
            assetBindings: [{
              slot: 'media-1',
              assetId: 'asset-1',
              filePath: '/library/evidence.jpg',
              kind: 'image',
              usage: 'required',
              required: true,
              lockedByUser: true,
              treatment: {},
              placement: { x: 0, y: 0, width: 1920 },
            }],
            motionCard: {
              tsx: 'export default function New(){ return null; }',
              compiledAt: 2,
              prompt: '',
              retryCount: 0,
            },
          }) as never,
        },
      );

      const reloaded = JSON.parse(readFileSync(file, 'utf-8'));
      expect(reloaded.aiAnalysis.analysisResult.cards[0].title).toBe('new');
      const overlay = reloaded.timeline.overlays.find((item: { id: string }) => item.id === 'overlay-1');
      expect(overlay.aiCardData.title).toBe('new');
      expect(overlay.aiCardData.assetBindings[0]).toMatchObject({
        slot: 'media-1',
        usage: 'required',
        lockedByUser: true,
      });
      expect(overlay.aiCardData.motionCard.tsxPath).toBe('ai-cards/overlay-1/motionCard.tsx');
      expect(readFileSync(path.join(dir, overlay.aiCardData.motionCard.tsxPath), 'utf-8'))
        .toContain('function New');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runRegenerateCardMedia', () => {
  it('regenerates image media for an image card and persists content', async () => {
    const imageCard = {
      ...CARD,
      type: 'image',
      content: {
        mediaType: 'image',
        assetPath: null,
        aspectRatio: '16:9',
        prompt: 'a cat',
        providerId: null,
        model: null,
        generationStatus: 'idle',
      },
    };
    const dir = project(imageCard, SEG);
    const u = ud();
    try {
      const res = await runRegenerateCardMedia(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
        {
          generateImage: async (args) =>
            ({
              mediaType: 'image',
              assetPath: 'ai-cards/c1/image.png',
              aspectRatio: '16:9',
              prompt: args.prompt,
              providerId: 'p1',
              model: 'm1',
              generationStatus: 'ready',
            }) as never,
        },
      );
      expect((res as { content: { assetPath: string } }).content.assetPath).toBe('ai-cards/c1/image.png');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].content.generationStatus).toBe('ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('throws not_media_card for a non-media card', async () => {
    const dir = project(CARD, SEG);
    const u = ud();
    try {
      await expect(
        runRegenerateCardMedia(
          { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1' } },
          { generateImage: async () => ({}) as never },
        ),
      ).rejects.toMatchObject({ code: 'not_media_card' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runConvertCard to=image (local rewrite, no generation)', () => {
  it('rewrites card type to image and persists', async () => {
    const dir = project(CARD, SEG);
    const u = ud();
    try {
      const res = await runConvertCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1', to: 'image' } },
        {},
      );
      expect((res as { type: string }).type).toBe('image');
      expect((res as { content: { generationStatus: string } }).content.generationStatus).toBe('idle');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].type).toBe('image');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('refuses to convert an approved Agent composite outside the director desk', async () => {
    const production = createEmptyProductionState(1);
    production.approvedPlan = {
      revision: 1,
      approvedAt: 2,
      segments: [{
        ...SEG,
        enabled: true,
        purpose: 'evidence',
        carrier: 'concept',
        intensity: 2,
        visualType: 'footage',
        renderStrategy: 'agent-composite',
        rationale: '真实素材与解释层缺一不可',
      }],
    } as never;
    const dir = project(CARD, SEG, production);
    const u = ud();
    try {
      await expect(runConvertCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1', to: 'image' } },
        {},
      )).rejects.toMatchObject({ code: 'approved_director_contract_locked' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runConvertCard to=motion (segment plan, generate+merge)', () => {
  it('converts an image card to motion preserving id/time', async () => {
    const imageCard = {
      ...CARD,
      type: 'image',
      content: {
        mediaType: 'image',
        assetPath: null,
        aspectRatio: '16:9',
        prompt: 'a cat',
        providerId: null,
        model: null,
        generationStatus: 'idle',
      },
    };
    const dir = project(imageCard, SEG);
    const u = ud();
    try {
      const res = await runConvertCard(
        { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1', to: 'motion' } },
        {
          regenerate: async (_e, card, segment) =>
            ({
              ...card,
              type: 'summary',
              segmentId: segment.id,
              motionCard: { tsx: 'export default () => null' },
            }) as never,
        },
      );
      expect((res as { id: string }).id).toBe('c1');
      expect((res as { type: string }).type).toBe('summary');
      expect((res as { renderMode: string }).renderMode).toBe('motion-card');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].renderMode).toBe('motion-card');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runConvertCard bad target', () => {
  it('throws bad_convert_target', async () => {
    const dir = project(CARD, SEG);
    const u = ud();
    try {
      await expect(
        runConvertCard(
          { projectPath: dir, userDataPath: u, handle: handle() as never, params: { cardId: 'c1', to: 'frob' } },
          {},
        ),
      ).rejects.toMatchObject({ code: 'bad_convert_target' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});
