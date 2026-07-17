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

function project(card: unknown, segment: unknown): string {
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
          regenerate: async (_e, card, _s, _set, opts) => {
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
      expect(captured?.animationDirection).toBe('逐拍：先标题后正文');
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
