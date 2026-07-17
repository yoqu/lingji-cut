// tests/image-card-form.test.tsx
//
// 注意：项目测试环境为 vitest node + 静态 SSR（renderToStaticMarkup），
// 未引入 @testing-library/react / jsdom。本文件遵循 media-card-preview.test.tsx
// 的范式做结构断言。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ImageCardForm } from '../src/components/media-card/ImageCardForm';
import type { AICard, MediaCardContent } from '../src/types/ai';

function makeCard(status: MediaCardContent['generationStatus'] = 'idle'): AICard {
  return {
    id: 'c1',
    segmentId: 's1',
    type: 'image',
    title: 'demo',
    content: {
      mediaType: 'image',
      assetPath: status === 'ready' ? 'ai-cards/c1/image.png' : null,
      aspectRatio: '16:9',
      prompt: 'a cat',
      providerId: 'p1',
      model: 'm1',
      generationStatus: status,
    },
    startMs: 0,
    endMs: 5000,
    displayDurationMs: 5000,
    displayMode: 'fullscreen',
    template: 'image-default',
    enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
  };
}

describe('ImageCardForm', () => {
  it('idle 渲染主按钮文案为生成图片', () => {
    const html = renderToStaticMarkup(
      <ImageCardForm
        card={makeCard('idle')}
        previewSrc={null}
        imageProviders={[{ id: 'p1', name: 'p1', models: ['m1'] }]}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('生成图片');
    expect(html).not.toContain('重新生成图片');
    expect(html).toContain('保存设置');
    expect(html).toContain('关闭');
  });

  it('ready 渲染主按钮文案为重新生成图片', () => {
    const html = renderToStaticMarkup(
      <ImageCardForm
        card={makeCard('ready')}
        previewSrc="file:///fake.png"
        imageProviders={[{ id: 'p1', name: 'p1', models: ['m1'] }]}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('重新生成图片');
  });

  it('generating 主按钮变成停止，进度留在预览区', () => {
    const html = renderToStaticMarkup(
      <ImageCardForm
        card={makeCard('generating')}
        previewSrc={null}
        percent={50}
        imageProviders={[{ id: 'p1', name: 'p1', models: ['m1'] }]}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('停止');
    expect(html).toContain('正在生成图片 50%');
  });

  it('使用统一生成语言，并渐进披露服务与模型', () => {
    const html = renderToStaticMarkup(
      <ImageCardForm
        card={makeCard('idle')}
        previewSrc={null}
        imageProviders={[{ id: 'p1', name: 'p1', models: ['m1'] }]}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toMatch(/a cat/);
    expect(html).toMatch(/移除绿幕背景/);
    expect(html).toContain('生成描述');
    expect(html).toContain('<details');
    expect(html).toContain('高级生成设置');
    expect(html).toContain('生成服务');
    expect(html).toContain('模型');
    expect(html).not.toContain('Provider');
    expect(html).not.toContain('Model');
  });

  it('生成动作提交当前表单构造的完整设置', () => {
    const source = readFileSync(
      new URL('../src/components/media-card/ImageCardForm.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const handleGenerate = () => onGenerate(buildUpdates())');
    expect(source).toContain('negativePrompt: negativePrompt.trim()');
    expect(source).toContain('backgroundRemoval,');
    expect(source).toContain('providerId,');
    expect(source).toContain('model,');
  });
});
