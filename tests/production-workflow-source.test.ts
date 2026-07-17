import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('导演制作流程契约', () => {
  it('时间轴原子替换后进入 Animatic 检查点并由模式决定是否自动批准', () => {
    const source = readFileSync(
      new URL('../src/lib/director-production-persistence.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('timeline.replaceAICardsOnTimeline(');
    expect(source).toContain("kind: 'set-workflow', stage: 'animatic-review'");
    expect(source).toContain("if (production.workflow.mode === 'director')");
    expect(source).toContain("kind: 'approve-animatic', complete: true");
  });

  it('UI 与 headless 分析入口都加载可配置导演制作规则', () => {
    const ipcSource = readFileSync(
      new URL('../electron/ai-generation-ipc.ts', import.meta.url),
      'utf8',
    );
    const headlessSource = readFileSync(
      new URL('../electron/pipeline/runs/analyze-run.ts', import.meta.url),
      'utf8',
    );
    for (const source of [ipcSource, headlessSource]) {
      expect(source).toContain("loadEffectivePromptTemplate('production.director'");
      expect(source).toContain('directorTemplate');
    }
  });

  it('声音素材按 cueId 精确替换并在修改提示词时移除旧音轨', () => {
    const panel = readFileSync(
      new URL('../src/components/production/ProductionPanel.tsx', import.meta.url),
      'utf8',
    );
    const workflow = readFileSync(
      new URL('../src/lib/director-audio-track.ts', import.meta.url),
      'utf8',
    );
    expect(panel).toContain('audioData?.cueId === cue.id');
    expect(panel).toContain('timeline.removeOverlay(overlay.id)');
    expect(panel).toContain('cueId: cue.id');
    expect(workflow).toContain('cueId: cue.id');
  });
});
