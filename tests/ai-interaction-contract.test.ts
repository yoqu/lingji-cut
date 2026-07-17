import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('unified AI interaction contract', () => {
  it('uses a neutral cancelled terminal state across cancellable workflows', () => {
    const taskStore = read('../src/store/task-progress.ts');
    const workflow = read('../src/hooks/useAIVideoWorkflow.ts');
    const workbench = read('../src/pages/ScriptWorkbench.tsx');
    const aiStore = read('../src/store/ai.ts');
    const pipelineBridge = read('../src/lib/pipeline-progress-bridge.ts');

    expect(taskStore).toContain("'active' | 'completed' | 'error' | 'cancelled'");
    expect(workflow).toContain('store.cancelTask(taskId, reason)');
    expect(workflow).not.toContain('store.failTask(taskId, reason)');
    expect(workbench).toContain('signal: abortController.signal');
    expect(workbench).toContain("cancelTask(streamId, '用户停止')");
    expect(workbench).toContain("cancelTask(reviewTaskId, '用户停止')");
    expect(aiStore).toContain("cancelTask(taskEntry.taskId, '用户取消生成')");
    expect(pipelineBridge).toContain("deps.cancelTask(id, '任务已取消')");
  });

  it('keeps AI operation feedback inside product UI instead of native dialogs', () => {
    const surfaces = [
      '../src/App.tsx',
      '../src/pages/ScriptWorkbench.tsx',
      '../src/pages/Editor.tsx',
      '../src/pages/Settings.tsx',
      '../src/components/AIPanel.tsx',
      '../src/components/CoverEditorModal.tsx',
      '../src/components/media-card/VideoCardForm.tsx',
      '../src/components/settings/AIConfigTab.tsx',
      '../src/components/settings/TTSConfigTab.tsx',
    ].map(read);

    for (const surface of surfaces) {
      expect(surface).not.toMatch(/window\.(alert|confirm|prompt)\s*\(/);
    }
  });

  it('tracks publishing text, partition and cover generation in the shared task system', () => {
    const publish = read('../src/components/publish/PublishWorkbench.tsx');
    const covers = read('../src/components/publish/useCoverStudio.ts');

    expect(publish).toContain("category: 'publish'");
    expect(publish).toContain("startPublishAITask('生成发布文案'");
    expect(publish).toContain("startPublishAITask('推荐 B站分区'");
    expect(covers).toContain("category: 'cover'");
    expect(covers).toContain('startCoverTask(');
    expect(covers).toContain('completeTask(taskId)');
    expect(covers).toContain('failTask(taskId, message)');
  });

  it('uses system blue and restrained status feedback instead of legacy AI effects', () => {
    const cursor = read('../src/lib/virtual-cursor.ts');
    const workbenchStyles = read('../src/pages/ScriptWorkbench.module.css');
    const agentOverlay = read('../src/components/agent/AgentOpOverlay.tsx');

    expect(cursor).toContain('var(--color-system-blue, #0A84FF)');
    expect(cursor).not.toMatch(/#a78bfa|#34d399|🤖|🔍/i);
    expect(workbenchStyles).not.toMatch(/radial-gradient|reviewScanLine|reviewGlowBreathing/);
    expect(agentOverlay).not.toContain('<AgentCursor');
    expect(agentOverlay).not.toContain('styles.ring');
  });

  it('uses one product vocabulary for stopping tasks and choosing generation services', () => {
    const taskPanel = read('../src/components/TaskProgressPanel.tsx');
    const aiConfig = read('../src/components/settings/AIConfigTab.tsx');
    const ttsConfig = read('../src/components/settings/TTSConfigTab.tsx');
    const imageForm = read('../src/components/media-card/ImageCardForm.tsx');
    const videoForm = read('../src/components/media-card/VideoCardForm.tsx');

    expect(taskPanel).toContain('title="停止"');
    expect(taskPanel).not.toContain('title="取消任务"');
    expect(aiConfig).toContain('label="文本生成服务"');
    expect(aiConfig).toContain('label="图片生成服务"');
    expect(aiConfig).toContain('label="视频生成服务"');
    expect(ttsConfig).toContain('label="口播生成服务"');
    expect(imageForm).toContain('>生成服务</label>');
    expect(videoForm).toContain('>生成服务</label>');
  });
});
