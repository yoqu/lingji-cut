import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AICoverPanel } from '../src/components/AICoverPanel';

describe('AICoverPanel', () => {
  it('renders prompts and generated cover candidates', () => {
    const html = renderToStaticMarkup(
      <AICoverPanel
        coverPrompts={['一张科技感播客封面', '第二条不应显示']}
        candidates={[
          {
            id: 'cover-1',
            prompt: '一张科技感播客封面',
            imageUrl: '/tmp/cover-1.png',
            selected: true,
          },
        ]}
        isGenerating={false}
        isRegeneratingPrompt={false}
        selectedCandidateId="cover-1"
        onGenerateCovers={() => undefined}
        onSavePrompt={() => undefined}
        onRegeneratePrompt={() => undefined}
        onSelectCover={() => undefined}
        onAddToTimeline={() => undefined}
        onEditCover={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-cover-root="true"');
    expect(html).toContain('data-ai-cover-prompt="true"');
    expect(html).toContain('提示词');
    expect(html).toContain('一张科技感播客封面');
    expect(html).not.toContain('第二条不应显示');
    expect(html).toContain('重写提示词');
    expect(html).toContain('重新生成封面图');
    expect(html).toContain('候选封面');
    expect(html).toContain('可直接拖到时间轴，也可以一键设为整期背景。');
    expect(html).toContain('data-ai-cover-grid="true"');
    expect(html).toContain('data-ai-cover-selected="true"');
    expect(html).toContain('设为整期背景');
    expect(html).toContain('draggable="true"');
  });

  it('shows the real inline phases for prompt and cover generation', () => {
    const html = renderToStaticMarkup(
      <AICoverPanel
        coverPrompts={['播客封面提示词']}
        candidates={[]}
        isGenerating
        isRegeneratingPrompt
        generationPhase="保存封面图"
        promptPhase="分析字幕并重写提示词"
        onGenerateCovers={() => undefined}
        onSavePrompt={() => undefined}
        onRegeneratePrompt={() => undefined}
        onSelectCover={() => undefined}
        onAddToTimeline={() => undefined}
        onEditCover={() => undefined}
      />,
    );

    expect(html).toContain('分析字幕并重写提示词');
    expect(html).toContain('保存封面图');
    expect(html).toContain('重写中...');
    expect(html).toContain('生成中...');
  });
});
