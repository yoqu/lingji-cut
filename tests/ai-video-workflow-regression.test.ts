import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI video workflow regressions', () => {
  it('guards stale or canceled TTS runs before surfacing workflow errors', () => {
    const source = readFileSync(
      new URL('../src/hooks/useAIVideoWorkflow.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const currentRequestId = workflowSession.requestId');
    expect(source).toContain('workflowSession.requestId !== currentRequestId');
    expect(source).toContain("requestId: currentRequestId");
  });

  it('supports resuming AI clip generation from content analysis when reusable media is confirmed', () => {
    const workflowSource = readFileSync(
      new URL('../src/hooks/useAIVideoWorkflow.ts', import.meta.url),
      'utf8',
    );
    const editorSource = readFileSync(
      new URL('../src/pages/Editor.tsx', import.meta.url),
      'utf8',
    );

    expect(workflowSource).toContain('startFromStep?:');
    // initialStep 现在同时考虑 autoMode：autoMode=true 时默认从 script_generating 开始
    expect(workflowSource).toContain(
      "options?.startFromStep ?? (options?.autoMode ? 'script_generating' : 'tts_generating')",
    );
    expect(workflowSource).toContain('void runFromStep(initialStep, text, workflowSession.projectDir);');
    expect(editorSource).toContain('if (isActive && workflow.step === \'tts_done\' && projectDir)');
    expect(editorSource).toContain('continueFromTtsDone(projectDir)');
  });

  it('creates a task-progress item even when AI clip generation resumes from reusable media', () => {
    const workflowSource = readFileSync(
      new URL('../src/hooks/useAIVideoWorkflow.ts', import.meta.url),
      'utf8',
    );

    expect(workflowSource).toContain('function ensureWorkflowTask');
    expect(workflowSource).toContain("category: 'ai-analyze'");
    expect(workflowSource).toContain("label: '内容分析'");
    expect(workflowSource).toContain('ensureWorkflowTask(workflowTaskId, phase');
  });

  it('keeps task-progress synchronized during the arranging phase', () => {
    const workflowSource = readFileSync(
      new URL('../src/hooks/useAIVideoWorkflow.ts', import.meta.url),
      'utf8',
    );

    expect(workflowSource).toContain("label: '时间轴排布'");
    expect(workflowSource).toContain("subMessage: '准备中'");
    expect(workflowSource).toContain('const subMessage = `排布卡片 ${drafts.length}/${drafts.length}`');
    expect(workflowSource).toContain("category: 'ai-analyze'");
  });

  it('keeps subtitle replacement on the new confirmation-based AI invalidation path', () => {
    const appSource = readFileSync(
      new URL('../src/App.tsx', import.meta.url),
      'utf8',
    );
    const editorSource = readFileSync(
      new URL('../src/pages/Editor.tsx', import.meta.url),
      'utf8',
    );

    // aiAnalysis 落盘统一走 store 订阅，失效路径只需清内存态
    expect(appSource).toContain('clearAIAnalysis();');
    expect(appSource).toContain('const shouldReanalyze = window.confirm(');
    expect(appSource).toContain('await rerunAiAnalysisForEntries(entries);');
    expect(editorSource).toContain('open={Boolean(pendingReanalyzeEntries)}');
    expect(editorSource).toContain('void rerunAiAnalysisForCurrentSrt(pendingReanalyzeEntries);');
  });
});
