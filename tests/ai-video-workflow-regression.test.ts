import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function readWorkflowSources(): string {
  return [
    '../src/hooks/useAIVideoWorkflow.ts',
    '../src/hooks/ai-video-workflow/types.ts',
    '../src/hooks/ai-video-workflow/session.ts',
    '../src/hooks/ai-video-workflow/use-controls.ts',
    '../src/hooks/ai-video-workflow/progress.ts',
    '../src/hooks/ai-video-workflow/runner.ts',
    '../src/hooks/ai-video-workflow/tts-input.ts',
    '../src/hooks/ai-video-workflow/director-stage.ts',
  ].map(readSource).join('\n');
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('AI video workflow regressions', () => {
  it('guards stale or canceled TTS runs before surfacing workflow errors', () => {
    const source = readWorkflowSources();

    expect(source).toContain('const requestId = workflowSession.requestId');
    expect(source).toContain('workflowSession.requestId !== requestId');
    expect(source).toContain('requestId: options.requestId');
  });

  it('supports resuming AI clip generation from content analysis when reusable media is confirmed', () => {
    const workflowSource = readWorkflowSources();
    const editorSource = readSource('../src/pages/Editor.tsx');

    expect(workflowSource).toContain('startFromStep?:');
    // initialStep 现在同时考虑 autoMode：autoMode=true 时默认从 script_generating 开始
    expect(workflowSource).toContain('options?.startFromStep');
    expect(workflowSource).toContain("options?.autoMode ? 'script_generating' : 'tts_generating'");
    expect(workflowSource).toContain('prepared.initialStep');
    expect(workflowSource).toContain('prepared.scriptText');
    expect(editorSource).toContain('if (isActive && workflow.step === \'tts_done\' && projectDir)');
    expect(editorSource).toContain('continueFromTtsDone(projectDir)');
  });

  it('creates a task-progress item even when AI clip generation resumes from reusable media', () => {
    const workflowSource = readWorkflowSources();

    expect(workflowSource).toContain('function ensureWorkflowTask');
    expect(workflowSource).toContain("category: 'ai-analyze'");
    expect(workflowSource).toContain("label: '内容分析'");
    expect(workflowSource).toContain('ensureWorkflowTask(options.taskId, phase');
  });

  it('keeps task progress synchronized through the shared Director orchestrator', () => {
    const workflowSource = readWorkflowSources();
    const persistenceSource = readSource('../src/lib/director-production-persistence.ts');

    expect(workflowSource).toContain('const result = await runAutoDirectorOrchestrator({');
    expect(workflowSource).toContain("label: '时间轴排布'");
    expect(workflowSource).toContain('subMessage: message');
    expect(workflowSource).toContain(
      "const key = event.phase === 'director' ? 'director' : event.track;",
    );
    expect(workflowSource).toContain('averageTrackProgress(tracks)');
    expect(workflowSource).toContain("category: 'ai-analyze'");
    expect(persistenceSource).toContain('timeline.replaceAICardsOnTimeline(');
    expect(persistenceSource).toContain("kind: 'set-output', output: 'timeline'");
  });

  it('preserves current output while subtitle replacement creates a new Director draft', () => {
    const appSource = readSource('../src/App.tsx');
    const editorSource = readSource('../src/pages/Editor.tsx');
    const appReplanSource = sourceBetween(
      appSource,
      'const rerunAiAnalysisForEntries = useCallback(',
      'const resolveAudioDuration = useCallback(',
    );
    const editorReplanSource = sourceBetween(
      editorSource,
      'const rerunAiAnalysisForCurrentSrt = useCallback(',
      '// ── 生成观测视图停靠',
    );

    expect(appSource).not.toContain('window.confirm(');
    expect(appSource).toContain('open={Boolean(pendingSubtitleReanalysis)}');
    expect(appSource).toContain('await rerunAiAnalysisForEntries(entries);');
    expect(editorSource).toContain('open={Boolean(pendingReanalyzeEntries)}');
    expect(editorSource).toContain('await rerunAiAnalysisForCurrentSrt(pendingReanalyzeEntries);');
    for (const replanSource of [appReplanSource, editorReplanSource]) {
      expect(replanSource).toContain("label: '根据新字幕重拟导演方案'");
      expect(replanSource).toContain("phase: '保留当前成片并分析影响'");
      expect(replanSource).toContain('await requestDirectorPlan({');
      expect(replanSource).not.toContain('clearAIAnalysis');
    }
    expect(appReplanSource).toContain("setPage('director-workbench');");
    expect(editorReplanSource).toContain("setPage?.('director-workbench');");
  });
});
