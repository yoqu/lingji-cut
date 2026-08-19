import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AISettings, LLMProvider } from '../src/types/ai';
import { getBuiltinPromptTemplate } from '../src/lib/prompts';
import { emptyHubJobState } from '../src/lib/publish/hub-state';
import {
  validatePublishIngestDraft,
} from '../electron/publish-agent/contract';
import {
  createPublishIngestTools,
  PUBLISH_INGEST_TOOL_NAMES,
  shouldSkipIngestCoverPrompt,
} from '../electron/publish-agent/tools';
import type { WorkdirMediaScan } from '../electron/publish-agent/workdir-scan';
import type { ResolvedBinding } from '../src/lib/llm/binding-resolver';
import {
  buildPublishIngestCompletionPrompt,
  resolvePublishIngestModelCandidates,
} from '../electron/publish-agent/ingest-run';
import { addHubJob, loadHubCatalog, loadHubJobState, removeHubJob, saveHubJobState } from '../electron/publish/hub-store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'publish-ingest-'));
  tempDirs.push(dir);
  return dir;
}

const settings = { imageProviders: [], llmProviders: [] } as unknown as AISettings;
const template = getBuiltinPromptTemplate('publish.metadata');

async function executeTool(
  tools: ToolDefinition[],
  name: string,
  params: unknown = {},
): Promise<{ content: Array<{ type: string; text?: string }>; terminate?: boolean }> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    `call-${name}`,
    params,
    undefined,
    undefined,
    {} as never,
  ) as Promise<{ content: Array<{ type: string; text?: string }>; terminate?: boolean }>;
}

function payload(result: Awaited<ReturnType<typeof executeTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function runtime(
  workDir: string,
  extra?: {
    deps?: Parameters<typeof createPublishIngestTools>[0]['deps'];
    existingState?: ReturnType<typeof emptyHubJobState>;
    settings?: AISettings;
    scan?: WorkdirMediaScan;
    metadataBinding?: ResolvedBinding;
    coverBinding?: ResolvedBinding;
  },
) {
  return createPublishIngestTools({
    workDir,
    settings: extra?.settings ?? settings,
    userDataPath: workDir,
    accounts: [{ id: 'douyin_a', platform: 'douyin', accountName: 'a', status: 'valid' }],
    existingState: extra?.existingState ?? emptyHubJobState(),
    metadataTemplate: template,
    metadataBinding: extra?.metadataBinding,
    partitionTemplate: getBuiltinPromptTemplate('publish.partition'),
    coverTemplate: getBuiltinPromptTemplate('cover.regeneration'),
    coverBinding: extra?.coverBinding,
    scan: extra?.scan,
    persistDraft: async (state) => {
      await fs.mkdir(path.join(workDir, '.lingji'), { recursive: true });
      await fs.writeFile(path.join(workDir, '.lingji', 'publish.json'), JSON.stringify(state), 'utf-8');
    },
    deps: extra?.deps,
  });
}

describe('shouldSkipIngestCoverPrompt', () => {
  it('已有提示词或已有封面时跳过', () => {
    expect(shouldSkipIngestCoverPrompt({ existingCoverPrompt: 'x', hasCovers: false })).toEqual({
      skip: true,
      reason: 'existing-prompt',
      coverPrompt: 'x',
    });
    expect(shouldSkipIngestCoverPrompt({ hasCovers: true })).toEqual({
      skip: true,
      reason: 'covers-present',
    });
    expect(shouldSkipIngestCoverPrompt({ hasCovers: false })).toEqual({ skip: false });
  });
});

describe('validatePublishIngestDraft', () => {
  it('拒绝越界路径、缺成片、缺标题', () => {
    const workDir = tempDir();
    const exists = (p: string) => existsSync(p);
    expect(validatePublishIngestDraft({ title: 't' }, workDir, exists).ok).toBe(false);
    expect(validatePublishIngestDraft({ filePath: '/etc/passwd', title: 't' }, workDir, exists).ok).toBe(false);
    const video = path.join(workDir, 'a.mp4');
    writeFileSync(video, 'x');
    expect(validatePublishIngestDraft({ filePath: video }, workDir, exists).ok).toBe(false);
    const ok = validatePublishIngestDraft({ filePath: video, title: '一期' }, workDir, exists);
    expect(ok.ok).toBe(true);
  });

  it('封面路径必须存在于工作目录', () => {
    const workDir = tempDir();
    const video = path.join(workDir, 'a.mp4');
    writeFileSync(video, 'x');
    const result = validatePublishIngestDraft({
      filePath: video,
      title: '一期',
      covers: { '16:9': path.join(workDir, 'missing.png') },
    }, workDir, existsSync);
    expect(result.ok).toBe(false);
  });
});

describe('publish ingest tools', () => {
  it('工具名白名单完整', () => {
    expect(PUBLISH_INGEST_TOOL_NAMES).toHaveLength(7);
  });

  it('上下文注入程序扫描结果，不让模型挑成片', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'clip.mp4'), 'x'.repeat(2000));
    writeFileSync(path.join(workDir, 'notes.md'), '标题：测试');
    const created = await runtime(workDir);
    const ctx = payload(await executeTool(created.tools, 'publish_get_context'));
    const detected = ctx.detected as { video: { path: string }; excerpts: Array<{ text: string }> };
    expect(detected.video.path).toBe('clip.mp4');
    expect(detected.excerpts.some((item) => item.text.includes('标题：测试'))).toBe(true);
    expect(String(ctx.rule)).toContain('不要填写 filePath/covers');
  });

  it('读取文本并截断', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'a.md'), '标题：测试');
    const created = await runtime(workDir);
    const result = payload(await executeTool(created.tools, 'publish_read_text', { path: 'a.md' }));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('标题：测试');
  });

  it('生成文案走包装工具', async () => {
    const workDir = tempDir();
    const generateMetadata = vi.fn(async () => ({ title: 'AI标题', desc: '简介', tags: ['a'] }));
    const created = await runtime(workDir, { deps: { generateMetadata: generateMetadata as never } });
    const result = payload(await executeTool(created.tools, 'publish_generate_metadata', {
      sourceText: '口播内容',
    }));
    expect(result.ok).toBe(true);
    expect(result.title).toBe('AI标题');
    expect(generateMetadata).toHaveBeenCalled();
  });

  it('生成封面提示词走包装工具，并传入识别模型绑定', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'show.mp4'), 'mp4');
    const regenerateCoverPrompt = vi.fn(async () => ['扁平封面，深色背景']);
    const coverBinding = {
      provider: { id: 'P', name: 'doubao', type: 'openai_compatible', models: ['turbo'] },
      model: 'turbo',
    } as ResolvedBinding;
    const created = await runtime(workDir, {
      deps: { regenerateCoverPrompt: regenerateCoverPrompt as never },
      coverBinding,
    });
    const result = payload(await executeTool(created.tools, 'publish_generate_cover_prompt', {
      sourceText: '高阶智驾',
      currentTitle: '还能卖吗',
    }));
    expect(result.ok).toBe(true);
    expect(result.coverPrompt).toBe('扁平封面，深色背景');
    expect(regenerateCoverPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        projectBindings: null,
        binding: coverBinding,
      }),
    );
  });

  it('已有封面提示词时跳过 LLM', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'show.mp4'), 'mp4');
    const existing = emptyHubJobState();
    existing.coverPrompt = '已有封面提示词';
    const regenerateCoverPrompt = vi.fn(async () => ['不应调用']);
    const created = await runtime(workDir, {
      existingState: existing,
      deps: { regenerateCoverPrompt: regenerateCoverPrompt as never },
    });
    const ctx = payload(await executeTool(created.tools, 'publish_get_context'));
    expect((ctx.detected as { skipCoverPrompt: boolean }).skipCoverPrompt).toBe(true);
    const result = payload(await executeTool(created.tools, 'publish_generate_cover_prompt', {
      sourceText: '高阶智驾',
    }));
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'existing-prompt', coverPrompt: '已有封面提示词' });
    expect(regenerateCoverPrompt).not.toHaveBeenCalled();
  });

  it('扫描到封面时跳过封面提示词 LLM', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'show.mp4'), 'mp4');
    const regenerateCoverPrompt = vi.fn(async () => ['不应调用']);
    const scan: WorkdirMediaScan = {
      video: {
        absPath: path.join(workDir, 'show.mp4'),
        relativePath: 'show.mp4',
        size: 3,
        durationMs: 1000,
      },
      covers: {
        '16:9': {
          absPath: path.join(workDir, 'cover.png'),
          relativePath: 'cover.png',
          width: 1920,
          height: 1080,
          size: 10,
          ratio: '16:9',
        },
      },
      excerpts: [],
      videoCount: 1,
      imageCount: 1,
      textCount: 0,
    };
    const created = await runtime(workDir, {
      scan,
      deps: { regenerateCoverPrompt: regenerateCoverPrompt as never },
    });
    const ctx = payload(await executeTool(created.tools, 'publish_get_context'));
    expect((ctx.detected as { skipCoverPrompt: boolean }).skipCoverPrompt).toBe(true);
    const result = payload(await executeTool(created.tools, 'publish_generate_cover_prompt', {
      sourceText: '高阶智驾',
    }));
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'covers-present' });
    expect(regenerateCoverPrompt).not.toHaveBeenCalled();
  });

  it('封面提示词失败不阻断，返回可忽略错误', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'show.mp4'), 'mp4');
    const created = await runtime(workDir, {
      deps: {
        regenerateCoverPrompt: vi.fn(async () => {
          throw new Error('System protection triggered');
        }) as never,
      },
    });
    const result = payload(await executeTool(created.tools, 'publish_generate_cover_prompt', {
      sourceText: '高阶智驾',
    }));
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(String(result.hint)).toContain('可忽略');
  });

  it('已有 publish.json 经 get_context 回填', async () => {
    const workDir = tempDir();
    const existing = emptyHubJobState();
    existing.draft.filePath = path.join(workDir, 'show.mp4');
    existing.draft.title = '已有标题';
    existing.notes = '上次识别';
    const created = await runtime(workDir, { existingState: existing });
    const ctx = payload(await executeTool(created.tools, 'publish_get_context'));
    expect((ctx.existingDraft as { title: string }).title).toBe('已有标题');
    expect((ctx.existingDraft as { notes: string }).notes).toBe('上次识别');
  });

  it('校验通过后提交落盘', async () => {
    const workDir = tempDir();
    const video = path.join(workDir, 'show.mp4');
    writeFileSync(video, 'mp4');
    const created = await runtime(workDir);
    const submitted = await executeTool(created.tools, 'publish_submit_draft', {
      draft: { title: '能卖吗', desc: '简介', tags: ['智驾'], notes: '采用扫描成片' },
    });
    expect(submitted.terminate).toBe(true);
    expect(payload(submitted).ok).toBe(true);
    const saved = await loadHubJobState(workDir);
    expect(saved.draft.title).toBe('能卖吗');
    expect(saved.draft.filePath).toBe(video);
    expect(saved.notes).toBe('采用扫描成片');
    expect(created.getSubmittedDraft()?.draft.title).toBe('能卖吗');
  });

  it('已有物料文件时同步回写', async () => {
    const workDir = tempDir();
    const video = path.join(workDir, 'show.mp4');
    writeFileSync(video, 'mp4');
    writeFileSync(path.join(workDir, '发布物料.md'), '# old');
    const created = await runtime(workDir);
    await executeTool(created.tools, 'publish_submit_draft', {
      draft: { filePath: video, title: '新标题', desc: '新简介', tags: ['tag'] },
    });
    const md = await fs.readFile(path.join(workDir, '发布物料.md'), 'utf-8');
    expect(md).toContain('新标题');
    expect(md).toContain('## 标签');
  });
});

describe('buildPublishIngestCompletionPrompt', () => {
  it('未校验时要求继续识别并提交', () => {
    expect(buildPublishIngestCompletionPrompt(false)).toContain('publish_submit_draft');
    expect(buildPublishIngestCompletionPrompt(true)).toContain('立即调用');
  });
});

describe('resolvePublishIngestModelCandidates', () => {
  const llmA: LLMProvider = {
    id: 'A',
    name: 'A',
    type: 'openai_compatible',
    baseUrl: 'https://a.example/v1',
    apiKey: 'k',
    models: ['m1', 'm2'],
  };
  const llmB: LLMProvider = {
    id: 'B',
    name: 'B',
    type: 'openai_compatible',
    baseUrl: 'https://b.example/v1',
    apiKey: 'k',
    models: ['n1'],
  };

  function settings(overrides: Partial<AISettings> = {}): AISettings {
    return {
      llmProviders: [llmA, llmB],
      defaultProviderId: 'A',
      defaultModel: 'm1',
      promptBindings: {},
      ...overrides,
    } as AISettings;
  }

  it('未绑定发布模型时优先用全局默认，而不是规划模型', () => {
    const s = settings({
      promptBindings: { 'planning.segment': { providerId: 'B', model: 'n1' } },
    });
    expect(resolvePublishIngestModelCandidates(s, null)[0]).toBe('A/m1');
  });

  it('显式绑定 publish.metadata 时排在候选首位', () => {
    const s = settings({
      promptBindings: {
        'publish.metadata': { providerId: 'B', model: 'n1' },
        'planning.segment': { providerId: 'A', model: 'm2' },
      },
    });
    expect(resolvePublishIngestModelCandidates(s, null)[0]).toBe('B/n1');
  });

  it('项目绑定覆盖全局发布模型', () => {
    const s = settings({
      promptBindings: { 'publish.metadata': { providerId: 'A', model: 'm2' } },
    });
    expect(resolvePublishIngestModelCandidates(s, {
      'publish.metadata': { providerId: 'B', model: 'n1' },
    })[0]).toBe('B/n1');
  });
});

describe('hub-store 目录', () => {
  it('add / save / remove 往返', async () => {
    const userData = tempDir();
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'a.mp4'), 'x');
    await saveHubJobState(workDir, {
      ...emptyHubJobState(),
      draft: {
        ...emptyHubJobState().draft,
        filePath: path.join(workDir, 'a.mp4'),
        title: '目录一期',
      },
    });
    const added = await addHubJob(userData, workDir);
    expect(added.title).toBe('目录一期');
    const listed = await loadHubCatalog(userData);
    expect(listed.jobs).toHaveLength(1);
    await removeHubJob(userData, workDir);
    expect((await loadHubCatalog(userData)).jobs).toHaveLength(0);
    expect((await loadHubJobState(workDir)).draft.title).toBe('目录一期');
  });
});

describe('识别代码不含文件名硬规则', () => {
  it('contract 不绑定具体成片或封面文件名', async () => {
    const src = await fs.readFile(
      new URL('../electron/publish-agent/contract.ts', import.meta.url),
      'utf-8',
    );
    expect(src).not.toContain('cover_16-9');
    expect(src).not.toContain('_final');
    expect(src).not.toContain('发布物料.md');
  });
});
