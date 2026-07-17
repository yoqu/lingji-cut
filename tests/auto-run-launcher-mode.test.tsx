import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResumeProductionModePicker } from '../src/components/auto-run-launcher-helpers';
import { detectLauncherAutoRun } from '../src/lib/auto-run-launcher-detect';

describe('AutoRunLauncher 制作模式入口', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('恢复项目时明确显示一键成片和导演确认', () => {
    const html = renderToStaticMarkup(
      <ResumeProductionModePicker value="director" onChange={vi.fn()} />,
    );
    expect(html).toContain('制作模式');
    expect(html).toContain('一键成片');
    expect(html).toContain('导演确认');
    expect(html).toMatch(/aria-pressed="true"[^>]*>导演确认/u);
  });

  it('保留 restart 和已有制作计划标记，并提供制作总览入口', () => {
    const source = readFileSync(
      new URL('../src/components/AutoRunLauncher.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('setResumable(result)');
    expect(source).toContain('hasProductionPlan');
    expect(source).toContain('制作总览');
    expect(source).toContain("setPage('director-workbench')");
  });

  it('编辑器只保留轻量镜头导航，不再挂载完整批量制作面板', () => {
    const source = readFileSync(new URL('../src/pages/Editor.tsx', import.meta.url), 'utf8');
    expect(source).toContain('EditorShotNavigator');
    expect(source).not.toContain('<AIPanel');
  });

  it('已有时间轴和制作计划的项目识别为重新制作，并保留总览入口', async () => {
    const project = {
      timeline: { overlays: [{ overlayType: 'ai-card' }] },
      production: { version: 2, shots: [] },
      workflowMeta: { lastAutoParams: {
        templateId: 'news-broadcast', roleId: 'none', voiceId: 'voice', productionMode: 'director',
      } },
    };
    vi.stubGlobal('window', { electronAPI: {
      loadScriptFile: vi.fn(async (_dir: string, name: string) => name === 'script.md' ? '口播稿' : '原稿'),
      loadProject: vi.fn(async () => JSON.stringify(project)),
    } });
    const result = await detectLauncherAutoRun('/tmp/project');
    expect(result).toMatchObject({ kind: 'resumable', restart: true, hasProductionPlan: true });
  });

  it('手动写完稿后重新检测应跳过撰写阶段（起点=语音合成）', async () => {
    vi.stubGlobal('window', { electronAPI: {
      loadScriptFile: vi.fn(async (_dir: string, name: string) => name === 'script.md' ? '手写口播稿' : '原稿'),
      loadProject: vi.fn(async () => JSON.stringify({})),
    } });
    const result = await detectLauncherAutoRun('/tmp/project');
    expect(result).toMatchObject({ kind: 'resumable', nextStep: 'tts_generating' });
  });

  it('启动前实时重检磁盘产物，配置弹窗提供起始阶段选择', () => {
    const source = readFileSync(
      new URL('../src/components/AutoRunLauncher.tsx', import.meta.url),
      'utf8',
    );
    // 继续运行 / 配置并开始都必须先 refreshDetection，避免过期缓存起点
    expect(source).toContain('const refreshDetection');
    expect(source).toMatch(/handleResume = useCallback\(async \(\) => \{\s*const fresh = await refreshDetection\(\)/u);
    expect(source).toMatch(/handleOpenConfig = useCallback\(async \(\) => \{\s*const fresh = await refreshDetection\(\)/u);
    // 手动起始阶段选择器
    expect(source).toContain('listStartableSteps');
    expect(source).toContain('起始阶段');
    expect(source).toContain('launch(configParams, startStep)');
  });
});
