import { describe, expect, it } from 'vitest';
import {
  buildStandaloneCoverSource,
  parseStandaloneState,
} from '../src/lib/publish/standalone-state';
import { emptyPublishDraft } from '../src/lib/publish/draft';

describe('parseStandaloneState', () => {
  it('空 / 坏输入回退空态', () => {
    const empty = {
      draft: emptyPublishDraft(),
      topic: '',
      coverPrompt: '',
      history: [],
      publishedPlatforms: {},
    };
    expect(parseStandaloneState(null)).toEqual(empty);
    expect(parseStandaloneState('junk')).toEqual(empty);
    expect(parseStandaloneState({ draft: 42, history: 'x' })).toEqual(empty);
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
      topic: '主题',
      coverPrompt: '扁平插画风格封面…',
      history: [{ id: 'h1' }],
      publishedPlatforms: { douyin: 123 },
    };
    expect(parseStandaloneState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('covers 剔除非字符串项', () => {
    const parsed = parseStandaloneState({
      draft: { covers: { '3:4': '/c.png', '16:9': 0, '4:3': '' } },
    });
    expect(parsed.draft.covers).toEqual({ '3:4': '/c.png' });
  });
});

describe('buildStandaloneCoverSource', () => {
  it('主题与标题皆空返回 null', () => {
    expect(buildStandaloneCoverSource('  ', '')).toBeNull();
  });

  it('拼接主题与标题作为 LLM 素材', () => {
    const p = buildStandaloneCoverSource('新能源半年报', '谁在赚钱');
    expect(p).toContain('视频标题：谁在赚钱');
    expect(p).toContain('视频主题与内容：新能源半年报');
  });

  it('仅主题也可生成', () => {
    expect(buildStandaloneCoverSource('新能源', '')).toBe('视频主题与内容：新能源');
  });
});
