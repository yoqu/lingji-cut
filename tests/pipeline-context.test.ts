import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveProject,
  setActiveProjectPath,
  HeadlessProjectContext,
} from '../electron/pipeline/context';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'lingji-ctx-'));
}

const VALID_PROJECT_JSON = JSON.stringify({
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  timeline: null,
  aiAnalysis: { analysisResult: null, coverCandidates: [] },
  script: {
    templateId: 'x',
    annotations: [],
    reviewState: 'idle',
    lastReviewedDocVersion: 0,
  },
});

describe('resolveProject', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    setActiveProjectPath(null);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws project_not_found when directory does not exist', async () => {
    await expect(
      resolveProject('/nonexistent/dir/lingji-' + Date.now()),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });

  it('returns headless context for non-active project', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    const ctx = await resolveProject(dir);
    expect(ctx.mode).toBe('headless');
    expect(ctx.projectPath).toBe(dir);
    if (ctx.mode === 'headless') {
      expect(ctx.headless).toBeInstanceOf(HeadlessProjectContext);
    }
  });

  it('returns active context when path matches setActiveProjectPath', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    setActiveProjectPath(dir);
    const ctx = await resolveProject(dir);
    expect(ctx.mode).toBe('active');
  });
});

describe('HeadlessProjectContext', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('saveSection writes through the existing write lock and merges section', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    const ctx = new HeadlessProjectContext(dir);
    await ctx.saveSection('script', {
      templateId: 'news-broadcast',
      annotations: [],
      reviewState: 'idle',
      lastReviewedDocVersion: 0,
    });
    const re = await ctx.loadProjectData();
    expect(re.script.templateId).toBe('news-broadcast');
  });
});
