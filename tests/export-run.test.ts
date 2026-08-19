import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runExportHeadless } from '../electron/pipeline/runs/export-run';

function project(hasTimeline: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-ex-'));
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    version: 1, createdAt: 'x', updatedAt: 'x',
    timeline: hasTimeline ? { tracks: [], podcast: {} } : null,
    aiAnalysis: { analysisResult: null, coverCandidates: [] },
    script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
  }));
  return dir;
}
const handle = () => ({ taskId: 't', signal: new AbortController().signal, update: () => {}, log: () => {} });

describe('runExportHeadless', () => {
  it('reads timeline, calls renderer, returns outputPath', async () => {
    const dir = project(true);
    try {
      let calledWith: any = null;
      const res = await runExportHeadless(
        { projectPath: dir, userDataPath: '/ud', handle: handle() as never },
        { out: 'myout.mp4' },
        { render: async (args) => { calledWith = args; return { outputPath: args.outputPath }; } },
      );
      expect((res as any).outputPath).toBe(path.join(dir, 'myout.mp4'));
      expect(calledWith.projectDir).toBe(dir);
      expect(JSON.parse(calledWith.timeline)).toEqual({ tracks: [], podcast: {} });
      expect(calledWith.exportConfig.quality).toBe('balanced');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws no_timeline when timeline missing', async () => {
    const dir = project(false);
    try {
      await expect(
        runExportHeadless({ projectPath: dir, userDataPath: '/ud', handle: handle() as never }, {}, { render: async () => ({ outputPath: 'x' }) }),
      ).rejects.toMatchObject({ code: 'no_timeline' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
