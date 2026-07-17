import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAnalyzeHeadless } from '../electron/pipeline/runs/analyze-run';

function project(srt: string, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-an-'));
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    version: 1, createdAt: 'x', updatedAt: 'x', timeline: null,
    aiAnalysis: { analysisResult: null, coverCandidates: [] },
    script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
    ...extra,
  }));
  writeFileSync(path.join(dir, 'podcast-subtitles.srt'), srt);
  return dir;
}
const userData = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lingji-anud-'));
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ aiSettings: { llmProviders: [{ id: 'l1', name: 'x', type: 'openai_compatible', baseUrl: 'h', apiKey: 'k', models: ['m'] }], defaultProviderId: 'l1', defaultModel: 'm' } }));
  return d;
};
const handle = () => ({ taskId: 't', signal: new AbortController().signal, update: () => {}, log: () => {} });
const SRT = '1\n00:00:00,000 --> 00:00:02,000\n你好世界\n\n2\n00:00:02,000 --> 00:00:04,000\n再见世界\n';

describe('runAnalyzeHeadless', () => {
  it('parses SRT, runs analyzer, persists aiAnalysis to project.json', async () => {
    const dir = project(SRT);
    const ud = userData();
    try {
      const fakeResult = {
        segments: [{ id: 's1', title: '段1', summary: '', startMs: 0, endMs: 2000 }],
        cards: [{ id: 'c1', segmentId: 's1', type: 'summary', title: 't', content: '内容', startMs: 0, endMs: 2000, displayDurationMs: 2000, displayMode: 'pip', template: 'default', enabled: true, style: {} }],
        coverPrompts: ['封面提示'], summary: '总结', keywords: ['k'],
      };
      let receivedEntries = 0;
      const res = await runAnalyzeHeadless(
        { projectPath: dir, userDataPath: ud, handle: handle() as never },
        { analyze: async (entries) => { receivedEntries = entries.length; return fakeResult as never; } },
      );
      expect(receivedEntries).toBe(2);
      expect((res as any).cards.length).toBe(1);
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].id).toBe('c1');
      expect(saved.aiAnalysis.analysisResult.segments[0].id).toBe('s1');
      expect(saved.production.approvedPlan.revision).toBe(1);
      expect(saved.production.workflow.stage).toBe('production-running');
      expect(saved.production.outputs.cards.status).toBe('current');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ud, { recursive: true, force: true });
    }
  });

  it('passes generateWorkTitle that fill-if-empty short-circuits on existing meta.title', async () => {
    const dir = project(SRT, { meta: { title: '既有标题' } });
    const ud = userData();
    try {
      const fakeResult = {
        segments: [{ id: 's1', title: '段1', summary: '', startMs: 0, endMs: 2000 }],
        cards: [{ id: 'c1', segmentId: 's1', type: 'summary', title: 't', content: '内容', startMs: 0, endMs: 2000, displayDurationMs: 2000, displayMode: 'pip', template: 'default', enabled: true, style: {} }],
        coverPrompts: ['封面提示'], summary: '总结', keywords: ['k'],
      };
      let capturedOptions: Record<string, unknown> = {};
      await runAnalyzeHeadless(
        { projectPath: dir, userDataPath: ud, handle: handle() as never },
        {
          analyze: async (entries, _settings, options) => {
            capturedOptions = options;
            return fakeResult as never;
          },
        },
      );
      expect(typeof capturedOptions.generateWorkTitle).toBe('function');
      const generateWorkTitle = capturedOptions.generateWorkTitle as (
        planning: { summary: string; keywords: string[]; segments: unknown[] },
      ) => Promise<string | null>;
      await expect(
        generateWorkTitle({ summary: 's', keywords: [], segments: [] }),
      ).resolves.toBe('既有标题');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ud, { recursive: true, force: true });
    }
  });

  it('throws no_subtitles when SRT missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-an2-'));
    const ud = userData();
    try {
      await expect(
        runAnalyzeHeadless({ projectPath: dir, userDataPath: ud, handle: handle() as never }, { analyze: async () => ({}) as never }),
      ).rejects.toMatchObject({ code: 'no_subtitles' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ud, { recursive: true, force: true });
    }
  });
});
