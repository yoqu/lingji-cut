// tests/video-card-form.test.tsx
//
// 静态 SSR（renderToStaticMarkup）结构断言，与 image-card-form.test.tsx 保持一致。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { VideoCardForm } from '../src/components/media-card/VideoCardForm';
import type { AICard, MediaCardContent } from '../src/types/ai';

function makeCard(
  status: MediaCardContent['generationStatus'] = 'idle',
  overrides?: Partial<AICard>,
): AICard {
  const base: AICard = {
    id: 'c1',
    segmentId: 's1',
    type: 'video',
    title: 'demo',
    content: {
      mediaType: 'video',
      assetPath: status === 'ready' ? 'ai-cards/c1/video.mp4' : null,
      posterPath: status === 'ready' ? 'ai-cards/c1/poster.jpg' : null,
      mediaDurationMs: status === 'ready' ? 6000 : undefined,
      aspectRatio: '16:9',
      prompt: 'a cat running',
      providerId: 'v1',
      model: 'vidu-2',
      generationStatus: status,
    },
    startMs: 0,
    endMs: 6000,
    displayDurationMs: 6000,
    displayMode: 'fullscreen',
    template: 'video-default',
    enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
  };
  return { ...base, ...overrides };
}

describe('VideoCardForm', () => {
  it('idle 显示生成视频、生成时长与统一辅助操作', () => {
    const html = renderToStaticMarkup(
      <VideoCardForm
        card={makeCard('idle')}
        previewSrc={null}
        videoProviders={[
          { id: 'v1', name: 'v1', models: ['vidu-2'], durationOptions: [4, 6, 8] },
        ]}
        durationSeconds={6}
        onDurationSecondsChange={() => {}}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('生成视频');
    expect(html).toContain('生成时长');
    expect(html).toContain('6 秒');
    expect(html).toContain('保存设置');
    expect(html).toContain('关闭');
  });

  it('ready 显示重新生成视频', () => {
    const html = renderToStaticMarkup(
      <VideoCardForm
        card={makeCard('ready')}
        previewSrc="file:///fake.mp4"
        videoProviders={[
          { id: 'v1', name: 'v1', models: ['vidu-2'], durationOptions: [4, 6, 8] },
        ]}
        durationSeconds={6}
        onDurationSecondsChange={() => {}}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('重新生成视频');
  });

  it('高级设置使用生成服务/模型，并通过 details 渐进披露', () => {
    const html = renderToStaticMarkup(
      <VideoCardForm
        card={makeCard('idle')}
        previewSrc={null}
        videoProviders={[
          { id: 'v1', name: 'v1', models: ['vidu-2'], durationOptions: [4, 6, 8] },
        ]}
        durationSeconds={6}
        onDurationSecondsChange={() => {}}
        onGenerate={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('<details');
    expect(html).toContain('高级生成设置');
    expect(html).toContain('生成服务');
    expect(html).toContain('模型');
    expect(html).not.toContain('Provider');
    expect(html).not.toContain('Model');
  });

  it('生成草稿包含当前时长，并使用单个产品内确认框', () => {
    const formSource = readFileSync(
      new URL('../src/components/media-card/VideoCardForm.tsx', import.meta.url),
      'utf8',
    );
    const confirmSource = readFileSync(
      new URL('../src/components/media-card/useVideoGenConfirm.ts', import.meta.url),
      'utf8',
    );

    expect(formSource).toContain('extraParams: { ...base.extraParams, durationSeconds }');
    expect(formSource).toContain('onGenerate(buildUpdates())');
    expect(formSource).toContain('<ConfirmDialog');
    expect(formSource).toContain('下次不再提示');
    expect(confirmSource).not.toContain('window.confirm');
    expect(confirmSource).toContain("window.localStorage.setItem(SKIP_KEY, '1')");
  });
});
