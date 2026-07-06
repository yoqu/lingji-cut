import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCoverPromptHeadless, runCoverImagesHeadless } from '../electron/pipeline/runs/cover-run';

function project(withAnalysis: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-cov-'));
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 1,
      createdAt: 'x',
      updatedAt: 'x',
      timeline: null,
      aiAnalysis: {
        analysisResult: withAnalysis
          ? { segments: [], cards: [], coverPrompts: ['旧'], summary: '', keywords: [] }
          : null,
        coverCandidates: [],
      },
      script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
    }),
  );
  writeFileSync(path.join(dir, 'podcast-subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
  return dir;
}
const ud = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lingji-covud-'));
  writeFileSync(
    path.join(d, 'settings.json'),
    JSON.stringify({
      aiSettings: {
        // resolvePromptBinding('cover.regeneration', …) 同时解析 LLM 绑定（与 main.ts
        // generate-cover-images 处理体一致），故 fixture 需提供默认 LLM Provider，
        // 否则会因 PROVIDER_MISSING 抛错——这反映真实生产设置必然已配置 LLM。
        llmProviders: [
          { id: 'l1', name: 'llm', type: 'openai_compatible', baseUrl: 'h', apiKey: 'k', models: ['gpt'] },
        ],
        defaultProviderId: 'l1',
        defaultModel: 'gpt',
        imageProviders: [
          { id: 'i1', name: 'x', type: 'openai_image', baseUrl: 'h', apiKey: 'k', models: ['m'] },
        ],
        defaultImageProviderId: 'i1',
        defaultImageModel: 'm',
      },
    }),
  );
  return d;
};
const handle = () => ({ taskId: 't', signal: new AbortController().signal, update: () => {}, log: () => {} });

describe('runCoverPromptHeadless', () => {
  it('generates prompts and persists first into analysisResult.coverPrompts', async () => {
    const dir = project(true);
    const u = ud();
    try {
      const res = await runCoverPromptHeadless(
        { projectPath: dir, userDataPath: u, handle: handle() as never },
        { regenerate: async () => ['新封面提示词'] },
      );
      expect(res).toContain('新封面提示词');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.coverPrompts[0]).toBe('新封面提示词');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('passes workTitle resolved from project.json meta.title into regenerate opts', async () => {
    const dir = project(true);
    const u = ud();
    try {
      const projectJsonPath = path.join(dir, 'project.json');
      const data = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
      data.meta = { title: '标题真源' };
      writeFileSync(projectJsonPath, JSON.stringify(data));

      let capturedOpts: unknown;
      await runCoverPromptHeadless(
        { projectPath: dir, userDataPath: u, handle: handle() as never },
        {
          regenerate: async (_entries, _settings, opts) => {
            capturedOpts = opts;
            return ['新封面提示词'];
          },
        },
      );
      expect((capturedOpts as { workTitle?: string }).workTitle).toBe('标题真源');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });

  it('throws need_analysis when analysisResult is null', async () => {
    const dir = project(false);
    const u = ud();
    try {
      await expect(
        runCoverPromptHeadless(
          { projectPath: dir, userDataPath: u, handle: handle() as never },
          { regenerate: async () => ['x'] },
        ),
      ).rejects.toMatchObject({ code: 'need_analysis' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});

describe('runCoverImagesHeadless', () => {
  it('generates candidates and persists them', async () => {
    const dir = project(true);
    const u = ud();
    try {
      const res = await runCoverImagesHeadless(
        { projectPath: dir, userDataPath: u, handle: handle() as never },
        { generate: async () => [{ id: 'cc1', prompt: 'p', imageUrl: '/abs/cover.png', selected: true }] as never },
      );
      expect((res as unknown[])[0]).toMatchObject({ id: 'cc1' });
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.coverCandidates[0].id).toBe('cc1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(u, { recursive: true, force: true });
    }
  });
});
