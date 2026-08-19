import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFootageOverlay } from '../src/lib/director-production-persistence';
import { buildRenderPlan } from '../src/remotion/timeline-to-sequences';
import { useTimelineStore } from '../src/store/timeline';
import {
  DEFAULT_AI_CARDS_TRACK_ID,
  createDefaultTimeline,
  type OverlayItem,
} from '../src/types';
import type { FootagePlacement } from '../src/types/footage';

function placement(overrides: Partial<FootagePlacement> = {}): FootagePlacement {
  return {
    segmentIndex: 0,
    segmentId: 'seg-1',
    overlayId: 'footage-seg-1',
    startMs: 1_000,
    durationMs: 4_000,
    sourcePath: '/library/city.mp4',
    kind: 'video',
    trimStartMs: 3_200,
    score: 0.85,
    thumbnailFile: '/library/city.jpg',
    ...overrides,
  };
}

describe('buildFootageOverlay', () => {
  it('视频 footage：type=video、visual-2 轨、trimStartMs 透传、带 footageData 标记', () => {
    const overlay = buildFootageOverlay(placement(), { width: 1920, height: 1080 });
    expect(overlay).toMatchObject({
      id: 'footage-seg-1',
      type: 'video',
      assetPath: '/library/city.mp4',
      trackId: DEFAULT_AI_CARDS_TRACK_ID,
      startMs: 1_000,
      durationMs: 4_000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
      overlayType: 'media',
      trimStartMs: 3_200,
      footageData: { segmentId: 'seg-1', score: 0.85, thumbnailFile: '/library/city.jpg' },
    });
  });

  it('图片 footage：type=image 且无 trimStartMs', () => {
    const overlay = buildFootageOverlay(
      placement({ kind: 'image', sourcePath: '/library/photo.png', trimStartMs: 0 }),
      { width: 1920, height: 1080 },
    );
    expect(overlay.type).toBe('image');
    expect(overlay.trimStartMs).toBeUndefined();
  });

  it('执行导演的媒体窗口构图与镜头运动元数据', () => {
    const overlay = buildFootageOverlay(
      placement({ composition: 'media-window', cameraMove: 'push-in', mediaRole: 'evidence' }),
      { width: 1920, height: 1080 },
    );
    expect(overlay.position).toEqual({ x: 154, y: 86, width: 1613, height: 907 });
    expect(overlay.footageData).toMatchObject({ cameraMove: 'push-in', mediaRole: 'evidence' });
  });
});

describe('RenderableClip 链路的 trimStartMs', () => {
  it('buildRenderPlan 保留 footage 视频 overlay 及其 trimStartMs', () => {
    const timeline = createDefaultTimeline();
    timeline.podcast = { audioPath: '', srtPath: '', durationMs: 10_000 };
    timeline.tracks.push({ id: DEFAULT_AI_CARDS_TRACK_ID, kind: 'visual', label: '轨道 2', order: 2 });
    const overlay = buildFootageOverlay(placement(), { width: 1920, height: 1080 });
    timeline.overlays.push(overlay);

    const plan = buildRenderPlan(timeline, [], 30);
    const clip = plan.visual.find((item) => item.id === overlay.id);
    expect(clip?.kind).toBe('video');
    expect(clip?.overlay.trimStartMs).toBe(3_200);
    expect(clip?.overlay.footageData?.segmentId).toBe('seg-1');
  });

  it('VideoOverlay 把 trimStartMs 换算成 startFrom 传给 OffthreadVideo / Video', () => {
    // 源码级契约检查（与 tests/production-workflow-source.test.ts 同款）：
    // 组件渲染在 node 环境缺 Remotion 上下文，直接验证透传链路存在。
    const source = readFileSync(
      join(__dirname, '../src/remotion/overlays/VideoOverlay.tsx'),
      'utf-8',
    );
    expect(source).toContain('overlay.trimStartMs');
    expect(source).toContain('startFrom={startFrom}');
    expect(source).toContain('OffthreadVideo');
  });

  it('ImageOverlay 仅对 footage 图片启用 Ken Burns', () => {
    const source = readFileSync(
      join(__dirname, '../src/remotion/overlays/ImageOverlay.tsx'),
      'utf-8',
    );
    expect(source).toContain('kenBurnsStyle');
    expect(source).toContain('overlay.footageData');
  });
});

describe('footage overlay 与卡片的原子替换', () => {
  beforeEach(() => {
    useTimelineStore.setState({
      timeline: createDefaultTimeline(),
      srtEntries: [],
      assets: [],
      overlayClipboard: null,
    });
  });

  function footageOverlay(id: string, startMs: number): OverlayItem {
    return buildFootageOverlay(
      placement({ overlayId: id, startMs, segmentId: id }),
      { width: 1920, height: 1080 },
    );
  }

  it('移除旧 footage overlay、按 startMs 排序插入、自动补 visual-2 轨、单条撤销历史', () => {
    const store = useTimelineStore.getState();
    store.replaceAICardsOnTimeline([], [], {
      footageOverlays: [footageOverlay('f-b', 5_000), footageOverlay('f-a', 1_000)],
    });

    let state = useTimelineStore.getState();
    expect(state.timeline.tracks.some((track) => track.id === DEFAULT_AI_CARDS_TRACK_ID)).toBe(true);
    expect(state.timeline.overlays.map((overlay) => overlay.id)).toEqual(['f-a', 'f-b']);
    expect(state.historyPast).toHaveLength(1);

    // 二次提交：旧 footage（f-a/f-b）被整批替换，同段不重复出现
    store.replaceAICardsOnTimeline([], [], { footageOverlays: [footageOverlay('f-c', 2_000)] });
    state = useTimelineStore.getState();
    expect(state.timeline.overlays.map((overlay) => overlay.id)).toEqual(['f-c']);
  });

  it('不触碰非 footage overlay（卡片 / 普通媒体）', () => {
    const store = useTimelineStore.getState();
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/imported.png',
      trackId: 'visual-1',
      startMs: 0,
      durationMs: 3_000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    store.replaceAICardsOnTimeline([], [], { footageOverlays: [footageOverlay('f-a', 4_000)] });

    const state = useTimelineStore.getState();
    const paths = state.timeline.overlays.map((overlay) => overlay.assetPath);
    expect(paths).toContain('/tmp/imported.png');
    expect(paths).toContain('/library/city.mp4');
  });
});
