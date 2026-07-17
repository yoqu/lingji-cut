import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ban } from 'lucide-react';
import { getTaskSummary } from '../src/components/StatusBarTaskSummary';
import type { TaskProgressItem } from '../src/store/task-progress';

describe('StatusBarProgressLine', () => {
  it('is rendered by AppStatusBar as the unified top progress marker', () => {
    const statusBarSource = readFileSync(
      new URL('../src/components/AppStatusBar.tsx', import.meta.url),
      'utf8',
    );

    expect(statusBarSource).toContain("import { StatusBarProgressLine } from './StatusBarProgressLine';");
    expect(statusBarSource).toContain('<StatusBarProgressLine />');
  });

  it('maps the active primary task to a 2px determinate or animated progress line', () => {
    const progressLineSource = readFileSync(
      new URL('../src/components/StatusBarProgressLine.tsx', import.meta.url),
      'utf8',
    );

    expect(progressLineSource).toContain('data-mode={mode}');
    expect(progressLineSource).toContain('useProgressWidth(raw)');
    expect(progressLineSource).not.toContain('CATEGORY_COLORS');
    expect(progressLineSource).not.toContain('linear-gradient');
  });

  it('uses system blue for every active task and keeps streaming solid', () => {
    const statusBarStyles = readFileSync(
      new URL('../src/components/AppStatusBar.module.css', import.meta.url),
      'utf8',
    );

    expect(statusBarStyles).toContain('background: var(--color-system-blue)');
    expect(statusBarStyles).not.toMatch(/progressFillLine[^}]*linear-gradient/s);
  });

  it('uses lucide icons and exposes the neutral cancelled label', () => {
    const summarySource = readFileSync(
      new URL('../src/components/StatusBarTaskSummary.tsx', import.meta.url),
      'utf8',
    );
    const panelSource = readFileSync(
      new URL('../src/components/TaskProgressPanel.tsx', import.meta.url),
      'utf8',
    );

    expect(summarySource).toContain("from 'lucide-react'");
    expect(summarySource).toContain('已取消');
    expect(panelSource).toContain("from 'lucide-react'");
    expect(panelSource).toContain('cancelTask(task.id)');
    expect(`${summarySource}${panelSource}`).not.toMatch(/[🤖🔍🧠📥🎬🎙️🖼️📁📤✅❌⏹]/u);
  });

  it('renders a cancelled primary task as neutral 已取消 copy', () => {
    const cancelledTask: TaskProgressItem = {
      id: 'cancelled-task',
      category: 'ai-write',
      label: '生成口播稿',
      mode: 'streaming',
      progress: 42,
      phase: null,
      level: 0,
      canCancel: false,
      startedAt: 100,
      completedAt: 200,
      status: 'cancelled',
    };
    const summary = getTaskSummary(cancelledTask);
    expect(summary.label).toBe('生成口播稿 已取消');
    expect(summary.Icon).toBe(Ban);
  });
});
