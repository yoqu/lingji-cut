import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { runPublishMetadataHeadless } from '../electron/pipeline/runs/publish-metadata-run';

function fakeHandle() {
  return {
    taskId: 'tk',
    signal: new AbortController().signal,
    update: vi.fn(),
  } as never;
}

async function makeProject(data: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lingji-pubmeta-'));
  await writeFile(join(dir, 'project.json'), JSON.stringify(data), 'utf-8');
  return dir;
}

// 生成路径会走 resolvePromptBinding('publish.metadata', …)，需一个含默认 LLM Provider 的
// userData，否则 PROVIDER_MISSING 抛错（这反映真实生产设置必然已配置 LLM）。
async function makeUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lingji-pubmeta-ud-'));
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      aiSettings: {
        llmProviders: [
          { id: 'l1', name: 'llm', type: 'openai_compatible', baseUrl: 'h', apiKey: 'k', models: ['gpt'] },
        ],
        defaultProviderId: 'l1',
        defaultModel: 'gpt',
      },
    }),
    'utf-8',
  );
  return dir;
}

const BASE_PROJECT = {
  version: 1,
  createdAt: 't',
  updatedAt: 't',
  timeline: null,
  script: { templateId: 't', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
  aiAnalysis: {
    analysisResult: { summary: '总结', keywords: ['AI'], segments: [], coverPrompts: [], cards: [] },
    coverCandidates: [],
  },
};

describe('runPublishMetadataHeadless', () => {
  it('已有标题时跳过（fill-if-empty）', async () => {
    const dir = await makeProject({ ...BASE_PROJECT, meta: { title: '既有标题' } });
    const generate = vi.fn();
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: dir, handle: fakeHandle() },
      { generate },
    );
    expect(result).toEqual({ skipped: true, title: '既有标题' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('生成并落盘 meta + publish（title 镜像，desc/tags 只填空）', async () => {
    const dir = await makeProject({
      ...BASE_PROJECT,
      publish: { title: '', desc: '已有描述', tagsInput: '', thumbnail: '', bilibiliTid: '' },
    });
    const ud = await makeUserData();
    const generate = vi.fn().mockResolvedValue({ title: '新标题', desc: '新描述', tags: ['a', 'b'] });
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: ud, handle: fakeHandle() },
      { generate },
    );
    expect(result).toEqual({ skipped: false, title: '新标题' });
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf-8'));
    expect(saved.meta.title).toBe('新标题');
    expect(saved.publish.title).toBe('新标题');
    expect(saved.publish.desc).toBe('已有描述');
    expect(saved.publish.tagsInput).toBe('a, b');
  });

  it('force 时即使已有标题也重生成', async () => {
    const dir = await makeProject({ ...BASE_PROJECT, meta: { title: '旧标题' } });
    const ud = await makeUserData();
    const generate = vi.fn().mockResolvedValue({ title: '强制新标题', desc: '', tags: [] });
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: ud, handle: fakeHandle(), params: { force: true } },
      { generate },
    );
    expect(result).toEqual({ skipped: false, title: '强制新标题' });
  });

  it('无素材时抛 no_source', async () => {
    const dir = await makeProject({
      ...BASE_PROJECT,
      aiAnalysis: { analysisResult: null, coverCandidates: [] },
    });
    const generate = vi.fn();
    await expect(
      runPublishMetadataHeadless(
        { projectPath: dir, userDataPath: dir, handle: fakeHandle() },
        { generate },
      ),
    ).rejects.toMatchObject({ code: 'no_source' });
    expect(generate).not.toHaveBeenCalled();
  });
});
