import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StoryboardEditor } from '../src/components/motion-storyboard/StoryboardEditor';

const STORYBOARD = JSON.stringify({
  claim: '报名人数变化',
  carrier: 'data-hero',
  scene: '大数字与列表',
  focus: { beat: 1, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', adds: '标题' },
    { cue: 1, kind: 'accent', adds: '28842 人', motion: '数字计数' },
  ],
});

describe('StoryboardEditor', () => {
  it('renders structured storyboard controls', () => {
    const html = renderToString(
      <StoryboardEditor value={STORYBOARD} cueCount={2} onChange={vi.fn()} />,
    );
    expect(html).toContain('data-motion-storyboard-editor="true"');
    expect(html).toContain('报名人数变化');
    expect(html).toContain('data-hero');
    expect(html).toContain('28842 人');
    expect(html).toContain('添加拍');
  });
});
