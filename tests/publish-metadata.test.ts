import { describe, expect, it, vi } from 'vitest';
import {
  buildMetadataSource,
  buildPublishMetadataMessages,
  buildWorkTitlePatch,
  generatePublishMetadata,
  parsePublishMetadata,
} from '../src/lib/publish-metadata';
import { getBuiltinPromptTemplate } from '../src/lib/prompts';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import type { AISettings } from '../src/types/ai';

const FAKE_SETTINGS = {} as AISettings;
const TEMPLATE = getBuiltinPromptTemplate('publish.metadata');

describe('parsePublishMetadata', () => {
  it('解析标准结构', () => {
    expect(
      parsePublishMetadata({ title: '标题', desc: '描述', tags: ['a', 'b'] }),
    ).toEqual({ title: '标题', desc: '描述', tags: ['a', 'b'] });
  });

  it('剥离标签的 # 前缀并去重', () => {
    const md = parsePublishMetadata({ title: 't', desc: 'd', tags: ['#科技', '科技', '#AI'] });
    expect(md.tags).toEqual(['科技', 'AI']);
  });

  it('tags 为字符串时按分隔符拆分', () => {
    const md = parsePublishMetadata({ title: 't', desc: 'd', tags: '科技, AI 数码' });
    expect(md.tags).toEqual(['科技', 'AI', '数码']);
  });

  it('兼容 description / keywords 别名', () => {
    const md = parsePublishMetadata({ title: 't', description: 'dd', keywords: ['k'] });
    expect(md.desc).toBe('dd');
    expect(md.tags).toEqual(['k']);
  });

  it('全空时抛错', () => {
    expect(() => parsePublishMetadata({ title: '', desc: '', tags: [] })).toThrow();
  });
});

describe('buildPublishMetadataMessages', () => {
  it('约束规则与 JSON 契约进 systemPrompt，节目内容进 userMessage', () => {
    const { systemPrompt, userMessage } = buildPublishMetadataMessages(TEMPLATE, {
      sourceText: '内容X',
    });
    // 约束（含标题 ≤25 字硬限）+ 锁定 JSON 契约都在 system 位
    expect(systemPrompt).toContain('标题要求');
    expect(systemPrompt).toContain('不得超过 25 个字');
    expect(systemPrompt).toContain('【系统契约 · 不可修改】');
    // 数据在 user 位
    expect(userMessage).toContain('内容X');
    expect(userMessage).toContain('【节目内容】');
    expect(userMessage).not.toContain('【系统契约 · 不可修改】');
  });

  it('有已有标题时把参考块注入 userMessage', () => {
    const { userMessage } = buildPublishMetadataMessages(TEMPLATE, {
      sourceText: '内容',
      currentTitle: '旧标题',
    });
    expect(userMessage).toContain('旧标题');
    expect(userMessage).toContain('内容');
  });
});

describe('generatePublishMetadata', () => {
  it('调用注入的 generate 并解析结果', async () => {
    const fake = vi.fn().mockResolvedValue({ title: 'T', desc: 'D', tags: ['x'] });
    const md = await generatePublishMetadata(
      FAKE_SETTINGS,
      { sourceText: '节目内容' },
      { template: TEMPLATE, generateStructuredData: fake },
    );
    expect(md).toEqual({ title: 'T', desc: 'D', tags: ['x'] });
    expect(fake).toHaveBeenCalledOnce();
  });

  it('把 system / user 两段消息传给 generate', async () => {
    const fake = vi.fn().mockResolvedValue({ title: 'T', desc: 'D', tags: ['x'] });
    await generatePublishMetadata(
      FAKE_SETTINGS,
      { sourceText: '节目内容' },
      { template: TEMPLATE, generateStructuredData: fake },
    );
    const [, systemPrompt, userMessage] = fake.mock.calls[0];
    expect(systemPrompt).toContain('标题要求');
    expect(userMessage).toContain('节目内容');
  });

  it('sourceText 为空时抛错且不调用 LLM', async () => {
    const fake = vi.fn();
    await expect(
      generatePublishMetadata(
        FAKE_SETTINGS,
        { sourceText: '   ' },
        { template: TEMPLATE, generateStructuredData: fake },
      ),
    ).rejects.toThrow();
    expect(fake).not.toHaveBeenCalled();
  });
});

describe('buildMetadataSource', () => {
  it('拼接分析摘要/关键词/段落概要', () => {
    const source = buildMetadataSource(
      {
        summary: '本期讲AI',
        keywords: ['AI', '播客'],
        segments: [{ title: '开场', summary: '引入话题' }],
      },
      '',
    );
    expect(source).toContain('节目总结：本期讲AI');
    expect(source).toContain('关键词：AI、播客');
    expect(source).toContain('1. 开场：引入话题');
  });

  it('分析为空时回退字幕原文（截断 3000 字符）', () => {
    const source = buildMetadataSource(null, 'x'.repeat(4000));
    expect(source).toContain('字幕内容：');
    expect(source.length).toBeLessThan(3100);
  });

  it('段落最多取 16 条', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ title: `段${i + 1}` }));
    const source = buildMetadataSource({ segments }, '');
    expect(source).toContain('16. 段16');
    expect(source).not.toContain('17. 段17');
  });
});

describe('buildWorkTitlePatch', () => {
  it('title 双写镜像，desc/tags 只填空', () => {
    const project = {
      ...createDefaultProjectData(),
      publish: { title: '', desc: '已有描述', tagsInput: '', thumbnail: '', bilibiliTid: '' },
    };
    const patch = buildWorkTitlePatch(project, { title: '新', desc: '新描', tags: ['a', 'b'] });
    expect(patch.meta.title).toBe('新');
    expect(patch.publish.title).toBe('新');
    expect(patch.publish.desc).toBe('已有描述');
    expect(patch.publish.tagsInput).toBe('a, b');
  });
});
