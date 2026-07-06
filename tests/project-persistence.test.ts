import { describe, it, expect } from 'vitest';
import {
  type ProjectData,
  type ProjectPublishMeta,
  DEFAULT_PUBLISH_META,
  createDefaultProjectData,
  extractTimelineSection,
  extractAIAnalysisSection,
  extractScriptSection,
  extractPublishSection,
  extractMetaSection,
  resolveWorkTitle,
  mergeProjectSection,
} from '../src/lib/project-persistence';

describe('project-persistence', () => {
  it('createDefaultProjectData 返回 version 1 的默认结构', () => {
    const data = createDefaultProjectData();
    expect(data.version).toBe(1);
    expect(data.timeline).toBeNull();
    expect(data.aiAnalysis).toEqual({
      analysisResult: null,
      coverCandidates: [],
    });
    expect(data.script).toEqual({
      templateId: 'news-broadcast',
      annotations: [],
      reviewState: 'idle',
      lastReviewedDocVersion: 0,
    });
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it('extractTimelineSection 提取 timeline 段', () => {
    const data = createDefaultProjectData();
    data.timeline = { podcast: { audioPath: '/a.mp3', srtPath: '/a.srt', durationMs: 1000 } } as any;
    expect(extractTimelineSection(data)).toEqual(data.timeline);
  });

  it('mergeProjectSection 合并 timeline 段并更新 updatedAt', () => {
    const data = createDefaultProjectData();
    const before = data.updatedAt;
    const newTimeline = { podcast: { audioPath: '/b.mp3' } } as any;
    const merged = mergeProjectSection(data, 'timeline', newTimeline);
    expect(merged.timeline).toEqual(newTimeline);
    expect(merged.updatedAt).not.toBe(before);
    // 不改变其他段
    expect(merged.aiAnalysis).toEqual(data.aiAnalysis);
    expect(merged.script).toEqual(data.script);
  });

  it('mergeProjectSection 合并 aiAnalysis 段', () => {
    const data = createDefaultProjectData();
    const aiData = {
      analysisResult: { cards: [], coverPrompts: [], summary: 'test', keywords: [] },
      coverCandidates: [],
    };
    const merged = mergeProjectSection(data, 'aiAnalysis', aiData);
    expect(merged.aiAnalysis).toEqual(aiData);
  });

  it('mergeProjectSection 合并 script 段', () => {
    const data = createDefaultProjectData();
    const scriptData = { templateId: 'custom', annotations: [], reviewState: 'issues' as const, lastReviewedDocVersion: 3 };
    const merged = mergeProjectSection(data, 'script', scriptData);
    expect(merged.script).toEqual(scriptData);
  });

  it('含 stylePresetId 的 ProjectData 经序列化 → 反序列化后保留', () => {
    const data = mergeProjectSection(createDefaultProjectData(), 'stylePresetId', 'editorial-eink');
    const roundTripped = JSON.parse(JSON.stringify(data)) as ProjectData;
    expect(roundTripped.stylePresetId).toBe('editorial-eink');
  });

  it('mergeProjectSection 合并 publish 段并经序列化保留', () => {
    const publish: ProjectPublishMeta = {
      title: 'AI 生成标题',
      desc: 'AI 生成简介',
      tagsInput: '标签1, 标签2',
      thumbnail: '/covers/16x9.png',
      overrides: { douyin_a: { title: '抖音专属', desc: '', tagsInput: '', bilibiliTid: '' } },
    };
    const merged = mergeProjectSection(createDefaultProjectData(), 'publish', publish);
    const roundTripped = JSON.parse(JSON.stringify(merged)) as ProjectData;
    expect(roundTripped.publish).toEqual(publish);
  });

  it('extractPublishSection 对旧工程缺字段补默认值', () => {
    const data = createDefaultProjectData();
    // 默认结构不写入 publish，模拟旧工程
    expect(extractPublishSection(data)).toEqual(DEFAULT_PUBLISH_META);
    // 部分字段也会与默认值合并
    const partial = { ...data, publish: { title: '仅标题' } as ProjectPublishMeta };
    expect(extractPublishSection(partial)).toEqual({
      ...DEFAULT_PUBLISH_META,
      title: '仅标题',
    });
  });

  it('publish.history 经合并与序列化无损保留；旧工程缺 history 视为 undefined', () => {
    const publish: ProjectPublishMeta = {
      ...DEFAULT_PUBLISH_META,
      title: 't',
      history: [
        {
          id: 'h1',
          publishedAt: 1700000000000,
          fileName: 'out.mp4',
          filePath: '/p/out.mp4',
          shared: { title: 't', desc: 'd', tags: ['a'], bilibiliTid: 21 },
          targets: [{ accountId: 'douyin_a', platform: 'douyin', accountName: 'a' }],
          results: { douyin_a: { state: 'failed', message: 'cookie 过期' } },
          overallState: 'failed',
        },
      ],
    };
    const merged = mergeProjectSection(createDefaultProjectData(), 'publish', publish);
    const roundTripped = JSON.parse(JSON.stringify(merged)) as ProjectData;
    expect(roundTripped.publish?.history).toEqual(publish.history);
    // 旧工程（无 history）读取后 history 为 undefined
    expect(extractPublishSection(createDefaultProjectData()).history).toBeUndefined();
  });

  it('旧工程缺 stylePresetId 字段时反序列化为 undefined', () => {
    const data = createDefaultProjectData();
    // 默认结构不写入 stylePresetId，模拟旧工程读取
    const roundTripped = JSON.parse(JSON.stringify(data)) as ProjectData;
    expect(roundTripped.stylePresetId).toBeUndefined();
  });

  it('extractMetaSection 对旧工程缺 meta 段补默认值', () => {
    const data = createDefaultProjectData();
    expect(extractMetaSection(data)).toEqual({ title: '' });
  });

  it('mergeProjectSection 合并 meta 段并经序列化保留', () => {
    const data = createDefaultProjectData();
    const merged = mergeProjectSection(data, 'meta', { title: '爆款标题' });
    const roundTrip = JSON.parse(JSON.stringify(merged));
    expect(extractMetaSection(roundTrip)).toEqual({ title: '爆款标题' });
  });

  it('resolveWorkTitle 优先 meta.title，回退 publish.title，两者皆空返回空串', () => {
    const data = createDefaultProjectData();
    expect(resolveWorkTitle(data)).toBe('');
    const withPublish = mergeProjectSection(data, 'publish', {
      ...DEFAULT_PUBLISH_META,
      title: '发布段旧标题',
    });
    expect(resolveWorkTitle(withPublish)).toBe('发布段旧标题');
    const withMeta = mergeProjectSection(withPublish, 'meta', { title: '  真源标题  ' });
    expect(resolveWorkTitle(withMeta)).toBe('真源标题');
  });

  it('resolveWorkTitle 对纯空白 meta.title 回退 publish.title', () => {
    const withPublish = mergeProjectSection(createDefaultProjectData(), 'publish', {
      ...DEFAULT_PUBLISH_META,
      title: '发布段旧标题',
    });
    const blankMeta = mergeProjectSection(withPublish, 'meta', { title: '   ' });
    expect(resolveWorkTitle(blankMeta)).toBe('发布段旧标题');
  });
});
