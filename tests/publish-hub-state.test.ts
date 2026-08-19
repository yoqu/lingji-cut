import { describe, expect, it } from 'vitest';
import { emptyPublishDraft } from '../src/lib/publish/draft';
import {
  buildHubCoverSource,
  formatPublishMaterialsMarkdown,
  hubJobHasDraft,
  parseHubJobState,
  parseHubJobsCatalog,
  summarizeHubJob,
} from '../src/lib/publish/hub-state';

describe('parseHubJobState', () => {
  it('空 / 坏输入回退空态', () => {
    expect(parseHubJobState(null).draft).toEqual(emptyPublishDraft());
    expect(parseHubJobState('junk').history).toEqual([]);
    expect(parseHubJobState({ draft: 42 }).coverPrompt).toBe('');
  });

  it('完整状态往返', () => {
    const state = {
      draft: {
        filePath: '/v.mp4',
        title: 't',
        desc: 'd',
        tagsInput: 'a,b',
        thumbnail: '/t.png',
        covers: { '3:4': '/c.png' },
        bilibiliTid: '21',
      },
      coverPrompt: '扁平插画',
      notes: '选用成片 A',
      history: [{ id: 'h1' }],
      publishedPlatforms: { douyin: 123 },
      ingestedAt: 99,
    };
    expect(parseHubJobState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('covers 剔除非字符串项', () => {
    const parsed = parseHubJobState({
      draft: { covers: { '3:4': '/c.png', '16:9': 0, '4:3': '' } },
    });
    expect(parsed.draft.covers).toEqual({ '3:4': '/c.png' });
  });
});

describe('parseHubJobsCatalog', () => {
  it('忽略没有 workDir 的条目', () => {
    const catalog = parseHubJobsCatalog({
      jobs: [{ title: 'x' }, { workDir: '/a', title: '一期' }],
    });
    expect(catalog.jobs).toHaveLength(1);
    expect(catalog.jobs[0].workDir).toBe('/a');
    expect(catalog.jobs[0].title).toBe('一期');
  });
});

describe('summarizeHubJob / helpers', () => {
  it('缩略图优先 3:4', () => {
    const summary = summarizeHubJob('/tmp/show', parseHubJobState({
      draft: { title: '标题', covers: { '16:9': '/w.png', '3:4': '/p.png' } },
      publishedPlatforms: { douyin: 10, tencent: 20 },
    }));
    expect(summary.thumbnail).toBe('/p.png');
    expect(summary.lastPublishedAt).toBe(20);
    expect(summary.title).toBe('标题');
  });

  it('无标题时用目录名', () => {
    const summary = summarizeHubJob('/tmp/华为智驾', parseHubJobState(null));
    expect(summary.title).toBe('华为智驾');
  });

  it('hubJobHasDraft 要求成片与标题', () => {
    expect(hubJobHasDraft(parseHubJobState({ draft: { title: 't' } }))).toBe(false);
    expect(hubJobHasDraft(parseHubJobState({ draft: { filePath: '/a.mp4', title: 't' } }))).toBe(true);
  });

  it('buildHubCoverSource 皆空返回 null', () => {
    expect(buildHubCoverSource('  ', '')).toBeNull();
    expect(buildHubCoverSource('标题', '简介')).toContain('视频标题：标题');
  });

  it('物料 markdown 含标题简介标签', () => {
    const md = formatPublishMaterialsMarkdown({
      ...emptyPublishDraft(),
      title: '不跟华为合作',
      desc: '简介',
      tagsInput: '华为 智驾',
    });
    expect(md).toContain('## 标题');
    expect(md).toContain('不跟华为合作');
    expect(md).toContain('华为 智驾');
  });
});
