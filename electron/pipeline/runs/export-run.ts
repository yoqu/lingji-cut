import { join, isAbsolute } from 'node:path';
import { renderVideoHeadless, type RenderVideoArgs } from '../../remotion/render-video-headless';
import { loadProjectFile } from '../../project-file';
import { GenerationError } from '../generation-error';
import { makeMainTelemetry } from '../../telemetry/main-telemetry';
import type { GenerationRunCtx } from '../headless-generation';

interface ExportDeps {
  render?: (
    args: RenderVideoArgs,
    opts: {
      onProgress?: (f: number) => void;
      telemetry?: { emit: (kind: string, extra?: Record<string, unknown>) => void };
    },
  ) => Promise<{ outputPath: string }>;
}

/** 主进程 headless 导出 MP4 */
export async function runExportHeadless(
  ctx: GenerationRunCtx,
  params: { out?: string } = {},
  deps: ExportDeps = {},
): Promise<{ outputPath: string }> {
  const render = deps.render ?? renderVideoHeadless;
  const { projectPath, handle } = ctx;
  handle.update({ phase: '读取时间线', percent: 5 });
  const project = await loadProjectFile(projectPath);
  if (!project.timeline) {
    throw new GenerationError('no_timeline', '项目没有时间线，无法导出。请先完成编辑。');
  }
  const outName = params.out && params.out.trim() ? params.out.trim() : 'export.mp4';
  const outputPath = isAbsolute(outName) ? outName : join(projectPath, outName);

  handle.update({ phase: '渲染', percent: 10 });
  // 与 UI 侧 render-video IPC 同构地接 auto-run jsonl，headless 导出慢时同样可读日志诊断。
  const tel = makeMainTelemetry(`export-${Date.now()}-${handle.taskId.slice(0, 8)}`);
  const startedAt = Date.now();
  tel.emit('run.start', { stage: 'export', resolution: '720p', quality: 'balanced', source: 'headless' });
  try {
    const result = await render(
      {
        projectDir: projectPath,
        timeline: JSON.stringify(project.timeline),
        outputPath,
        exportConfig: { resolution: '720p', quality: 'balanced' },
      },
      {
        onProgress: (f) => handle.update({ phase: '渲染', percent: Math.min(99, Math.round(f * 100)) }),
        telemetry: tel,
      },
    );
    tel.emit('run.end', { stage: 'export', durationMs: Date.now() - startedAt, ok: true });
    handle.update({ phase: '完成', percent: 100 });
    return result;
  } catch (err) {
    tel.emit('run.end', {
      stage: 'export',
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
