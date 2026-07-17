import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { AICardInspector } from '../src/components/AICardInspector';

describe('AICardInspector', () => {
  const baseCardStyle = {
    primaryColor: '#6366f1',
    backgroundColor: '#0f172a',
    fontSize: 48,
  } as const;

  it('renders the design-aligned sections, motion state and danger zone', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-1',
          segmentId: 'segment-1',
          type: 'summary',
          title: 'AI 驱动的未来',
          content: '人工智能正在改变我们的创作方式。',
          startMs: 0,
          endMs: 45_000,
          displayDurationMs: 5_000,
          displayMode: 'fullscreen',
          template: 'summary-default',
          enabled: true,
          style: baseCardStyle,
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-card-section="text-content"');
    expect(html).toContain('data-ai-card-section="display-settings"');
    expect(html).toContain('data-ai-card-section="preview"');
    expect(html).toContain('data-ai-card-section="danger"');
    expect(html).toContain('文字内容');
    expect(html).toContain('展示设置');
    expect(html).toContain('Motion 卡片状态');
    expect(html).toContain('危险操作');
    expect(html).toContain('尚未生成 Remotion 动画');
    expect(html).toContain('全屏模式');
    expect(html).toContain('重新生成');
    expect(html).toContain('保存');
    expect(html).toContain('删除此卡片');
  });

  it('image 卡 → 渲染 ImageCardForm 表单（提示词字段与画幅比例）', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-image',
          segmentId: 'segment-1',
          type: 'image',
          title: '图片卡',
          content: {
            mediaType: 'image',
            assetPath: null,
            aspectRatio: '16:9',
            prompt: '一只在月光下奔跑的猫',
            providerId: null,
            model: null,
            generationStatus: 'idle',
          },
          startMs: 0,
          endMs: 5_000,
          displayDurationMs: 5_000,
          displayMode: 'fullscreen',
          template: 'image-default',
          enabled: true,
          style: baseCardStyle,
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    // 图片表单应包含：prompt 文案、画幅比例、显示模式相关字段
    expect(html).toContain('一只在月光下奔跑的猫');
    expect(html).toMatch(/画幅比例/);
    expect(html).toMatch(/生成描述/);
    // 不应包含 text 卡专属 section
    expect(html).not.toContain('data-ai-card-section="text-content"');
    expect(html).not.toContain('Motion 卡片状态');
  });

  it('video 卡 → 渲染 VideoCardForm 表单（生成时长字段）', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-video',
          segmentId: 'segment-1',
          type: 'video',
          title: '视频卡',
          content: {
            mediaType: 'video',
            assetPath: null,
            posterPath: null,
            aspectRatio: '16:9',
            prompt: '日落时分海岸线',
            providerId: null,
            model: null,
            generationStatus: 'idle',
          },
          startMs: 0,
          endMs: 6_000,
          displayDurationMs: 6_000,
          displayMode: 'fullscreen',
          template: 'video-default',
          enabled: true,
          style: baseCardStyle,
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain('日落时分海岸线');
    expect(html).toMatch(/生成时长/);
    expect(html).not.toContain('data-ai-card-section="text-content"');
  });

  it('媒体生成同步保存草稿，并将当前 content 作为生成覆盖参数', () => {
    const source = readFileSync(
      new URL('../src/components/AICardInspector.tsx', import.meta.url),
      'utf8',
    );
    const syncSaves = source.match(/updateCard\(card\.id, updates\);/g) ?? [];
    const directOverrides = source.match(
      /regenerateCardMedia\(card\.id, contentOverrides\);/g,
    ) ?? [];

    expect(syncSaves).toHaveLength(2);
    expect(directOverrides).toHaveLength(2);
  });

  it('shows "motion card ready" once Remotion TSX is attached', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-motion',
          segmentId: 'segment-1',
          type: 'summary',
          title: 'Motion 卡片',
          content: '人工智能正在改变我们的创作方式。',
          startMs: 0,
          endMs: 45_000,
          displayDurationMs: 5_000,
          displayMode: 'fullscreen',
          template: 'summary-default',
          enabled: true,
          renderMode: 'motion-card',
          motionCard: {
            tsx: 'export default function Card(){ return null; }',
            compiledAt: 1_715_000_000_000,
            prompt: 'test',
            retryCount: 0,
          },
          style: baseCardStyle,
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain('Motion 卡片已就绪');
  });

  it('renders production report status and issues for motion cards', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-motion',
          segmentId: 'segment-1',
          type: 'summary',
          title: 'Motion 卡片',
          content: '人工智能正在改变我们的创作方式。',
          startMs: 0,
          endMs: 45_000,
          displayDurationMs: 5_000,
          displayMode: 'fullscreen',
          template: 'summary-default',
          enabled: true,
          renderMode: 'motion-card',
          motionCard: {
            tsx: 'export default function Card(){ return null; }',
            compiledAt: 1_715_000_000_000,
            prompt: 'test',
            retryCount: 0,
            productionReport: {
              status: 'acceptable',
              generatedAt: 123,
              framesChecked: [0, 75, 149],
              lintIssues: [
                { severity: 'warning', source: 'lint', code: 'cues-unused', message: '未使用 cues' },
              ],
              layoutIssues: [],
              reviewIssues: [],
              assetIssues: [],
              fallbackUsed: false,
              fixRounds: 1,
              reviewRounds: 0,
              renderOk: true,
              visualReviewAvailable: false,
              unavailableReason: '关键帧 contact sheet 已生成，但当前 reviewer 按文本审查降级。',
              contactSheetPath: '/tmp/sheet.png',
              contactSheetCached: true,
            },
          },
          style: baseCardStyle,
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-card-production-report="true"');
    expect(html).toContain('可接受');
    expect(html).toContain('修复 1 轮');
    expect(html).toContain('关键帧 3 个');
    expect(html).toContain('视觉审片暂未启用');
    expect(html).toContain('缩略审片图已生成');
    expect(html).toContain('缓存');
    expect(html).toContain('按文本审查降级');
    expect(html).toContain('静态检查');
    expect(html).toContain('未使用 cues');
  });

  it('renders bound asset controls and asset quality issues', () => {
    const html = renderToStaticMarkup(
      <AICardInspector
        card={{
          id: 'card-assets',
          segmentId: 'segment-1',
          type: 'motion',
          title: '资产卡',
          content: '内容',
          startMs: 0,
          endMs: 5_000,
          displayDurationMs: 5_000,
          displayMode: 'fullscreen',
          template: 'motion-default',
          enabled: true,
          style: baseCardStyle,
          assetBindings: [{
            slot: 'hero',
            assetId: 'asset-1',
            filePath: '/tmp/hero.png',
            treatment: {
              profile: 'editorial-realist-cutout',
              lighting: 'soft-left',
              palette: 'low-saturation',
              shadow: 'soft-ground',
              perspective: 'front-3q',
            },
            placement: { x: 100, y: 100, width: 500, depth: 'foreground' },
            request: {
              slot: 'hero',
              query: '旧档案袋',
              role: 'object',
              importance: 'primary',
              reusePolicy: 'prefer-library',
              visualTreatment: 'editorial-realist-cutout',
            },
          }],
        }}
        onRegenerate={async () => null}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-card-section="external-assets"');
    expect(html).toContain('外部资产');
    expect(html).toContain('旧档案袋');
    expect(html).toContain('重生资产');
    expect(html).toContain('资产中心');
  });
});
