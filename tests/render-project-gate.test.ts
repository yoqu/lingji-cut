import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

import {
  createRenderPublicDir,
  renderVideoHeadless,
} from '../electron/remotion/render-video-headless';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import { createDefaultTimeline, DEFAULT_VISUAL_TRACK_ID } from '../src/types';

const cleanup = new Set<string>();

afterEach(() => {
  for (const target of cleanup) rmSync(target, { recursive: true, force: true });
  cleanup.clear();
});

function renderArgs(projectDir: string) {
  return {
    projectDir,
    timeline: JSON.stringify(createDefaultTimeline()),
    outputPath: path.join(os.tmpdir(), 'lingji-render-project-gate.mp4'),
    exportConfig: { resolution: '720p' as const, quality: 'balanced' as const },
  };
}

describe('render project production gate', () => {
  it.each(['', 'relative/project'])('项目目录为 %j 时直接拒绝导出', async (projectDir) => {
    await expect(renderVideoHeadless(renderArgs(projectDir))).rejects.toThrow(
      projectDir ? /绝对路径/ : /缺少项目目录/,
    );
  });

  it('平衡编码档也会阻止 quality-blocked 项目', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'lingji-quality-blocked-'));
    cleanup.add(projectDir);
    const project = createDefaultProjectData();
    project.timeline = createDefaultTimeline();
    project.production = createEmptyProductionState(10);
    project.production.workflow = {
      ...project.production.workflow,
      stage: 'quality-blocked',
      error: '镜头生成失败',
    };
    writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project));

    await expect(renderVideoHeadless({
      ...renderArgs(projectDir),
      timeline: JSON.stringify(project.timeline),
    })).rejects.toThrow(/导出被制作门禁阻止.*质量阻断/u);
  });

  it('调用方删掉项目当前时间线画面时拒绝导出', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'lingji-timeline-mismatch-'));
    cleanup.add(projectDir);
    const project = createDefaultProjectData();
    project.timeline = createDefaultTimeline();
    project.timeline.overlays.push({
      id: 'persisted-shot',
      type: 'image',
      assetPath: '/project/persisted.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 1_000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project));

    await expect(renderVideoHeadless(renderArgs(projectDir))).rejects.toThrow(
      /导出时间线与项目当前时间线不一致/u,
    );
  });

  it('显式项目目录用于物化卡片的相对素材路径', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'lingji-render-assets-'));
    cleanup.add(projectDir);
    const relativeAsset = 'assets/generated/prop.png';
    mkdirSync(path.join(projectDir, 'assets/generated'), { recursive: true });
    writeFileSync(path.join(projectDir, relativeAsset), Buffer.from('png-bytes'));
    const timeline = createDefaultTimeline();
    timeline.overlays.push({
      id: 'motion-1',
      type: 'image',
      overlayType: 'ai-card',
      assetPath: '',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 1_000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
      aiCardData: {
        sourceCardId: 'card-1',
        cardType: 'motion',
        title: '素材卡',
        content: '',
        template: 'motion-default',
        displayMode: 'fullscreen',
        style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
        assetBindings: [{
          slot: 'media-1',
          assetId: 'asset-1',
          filePath: relativeAsset,
          treatment: {
            profile: 'editorial-realist-cutout',
            lighting: 'soft-left',
            palette: 'low-saturation',
            shadow: 'soft-ground',
            perspective: 'front-3q',
          },
          placement: { x: 0, y: 0, width: 1920, height: 1080 },
        }],
      },
    });

    const prepared = await createRenderPublicDir(timeline, projectDir);
    cleanup.add(prepared.publicDir);
    const publicPath = prepared.timeline.overlays[0]?.aiCardData?.assetBindings?.[0]?.filePath;

    expect(publicPath).toBe('assets/motion-1-asset-media-1-asset-1.png');
    expect(readFileSync(path.join(prepared.publicDir, publicPath!), 'utf-8')).toBe('png-bytes');
  });
});
