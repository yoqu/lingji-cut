import { useEffect, useRef } from 'react';
import { useAIStore, type WorkflowStep } from '../store/ai';
import { useScriptStore } from '../store/script';
import { useAIVideoWorkflow } from '../hooks/useAIVideoWorkflow';
import { getProjectDir } from '../store/timeline';
import { useTaskProgressStore } from '../store/task-progress';
import { AutoRunOverlay } from './AutoRunOverlay';
import type { AppPage } from '../lib/electron-api';
import type { VideoImportSourceType } from '../lib/video-import-types';

export interface AutoRunControllerProps {
  setPage: (next: AppPage) => void;
}

/** 导入「第 0 步」标签：按来源类型区分抖音 / 本地视频 / 本地音频。 */
function importStepLabel(sourceType: VideoImportSourceType | null): string {
  if (sourceType === 'local_video') return '导入本地视频';
  if (sourceType === 'local_audio') return '导入本地音频';
  return '导入抖音视频';
}

/**
 * AutoRunController：把 AutoRunOverlay 与 useAIVideoWorkflow 串起来的胶水。
 *
 * 职责：
 *   1. 挂载时根据 pendingMediaImport 区分 source（text vs media）。
 *   2. text 入口：立即从磁盘读 original.md → 触发 workflow.start。
 *   3. media 入口：AutoRunController 自行触发 importVideoSource，
 *      订阅 video-import-progress 写入统一进度条，并把导入过程当做
 *      "第 0 步"（虚拟 effectiveStep='douyin_importing'）展示给 overlay；
 *      导入 status==='done' 后再从 script_generating 起跑 useAIVideoWorkflow。
 *   4. 监听 workflow.step：done → 跳 editor；任务取消 → 跳 script-workbench。
 *   5. 真实失败保持在 overlay 上，由用户点 "查看脚本工作台" / "进入编辑器" 跳转。
 *   6. 所有离开路径（done / 取消 / 点击跳转）都必须清掉 pendingMediaImport，
 *      避免 ScriptWorkbench 二次消费。
 */
export function AutoRunController({ setPage }: AutoRunControllerProps) {
  const workflow = useAIStore((s) => s.workflow);
  const pendingAutoParams = useAIStore((s) => s.pendingAutoParams);
  const setPendingAutoParams = useAIStore((s) => s.setPendingAutoParams);
  const pendingAutoResumeStep = useAIStore((s) => s.pendingAutoResumeStep);
  const setPendingAutoResumeStep = useAIStore((s) => s.setPendingAutoResumeStep);
  const pendingMediaImport = useScriptStore((s) => s.pendingMediaImport);
  // 导入完成态：复用 script store 已有的 videoImportProgress.status
  // AutoRunController 的 media 分支订阅 video-import-progress 直接维护
  // 自己的导入任务进度（见下方 effect），script store 的 status 仅作
  // 起跑 useAIVideoWorkflow 的 done 信号兜底。
  const mediaImportStatus = useScriptStore(
    (s) => s.videoImportProgress?.status ?? null,
  );
  const projectDir = getProjectDir();
  const { start, cancel } = useAIVideoWorkflow();
  const startedRef = useRef(false);
  const mediaKickedRef = useRef(false);
  const mediaTaskIdRef = useRef<string | null>(null);
  // 记住本次导入来源类型，供任务条 / overlay 第 0 步标签按来源区分。
  const mediaSourceTypeRef = useRef<VideoImportSourceType | null>(null);
  // 取消 / 离开 auto-run 后置位，用于阻止在途 IPC 完成时回写 workflow 状态。
  const abortedRef = useRef(false);
  // 订阅 task store 的导入任务快照，供 overlay 展示"第 0 步"进度
  const mediaTask = useTaskProgressStore((s) =>
    mediaTaskIdRef.current ? s.tasks.get(mediaTaskIdRef.current) ?? null : null,
  );

  // source = 'media' if pending import exists when mounted OR we have already kicked the media flow
  const source: 'text' | 'media' =
    pendingMediaImport || mediaKickedRef.current ? 'media' : 'text';

  /**
   * media 分支：AutoRunController 自行触发 importVideoSource。
   * 这是 Task 11 的核心修复——之前 ScriptWorkbench 并未在 auto-run 页
   * 挂载，导入从来没被真正启动。
   */
  useEffect(() => {
    if (source !== 'media') return;
    if (!pendingMediaImport || !projectDir) return;
    if (mediaKickedRef.current) return;
    abortedRef.current = false; // 新一次 auto-run 起跑，重置取消标记
    mediaKickedRef.current = true;
    const importSource = pendingMediaImport;
    mediaSourceTypeRef.current = importSource.sourceType;
    // 立即清掉 pendingMediaImport，防止 ScriptWorkbench 后续二次消费
    useScriptStore.getState().setPendingMediaImport(null);

    void window.electronAPI
      .importVideoSource({
        ...importSource,
        projectDir,
        syncToOriginal: true,
      })
      .catch((err: unknown) => {
        if (abortedRef.current) return;
        // 进度错误通常会通过 video-import-progress 的 error snapshot 反映；
        // 这里兜底：若 IPC Promise 在任何 progress 事件前先 reject，
        // 直接把 workflow 设为 error 以便 overlay 展示错误 UI。
        useAIStore.getState().setWorkflow({
          step: 'error',
          error: err instanceof Error ? err.message : '媒体导入失败',
          failedStep: 'douyin_importing',
          canCancel: false,
        });
      });
  }, [source, pendingMediaImport, projectDir]);

  /**
   * media 分支：订阅 video-import-progress（onDouyinImportProgress 为共享通道，
   * 命名沿用历史）把进度 push 到统一任务条。
   * 这样底部 AppStatusBar 也能看到导入第 0 步的进度（符合 PROGRESS-SPEC）。
   */
  useEffect(() => {
    if (source !== 'media' || !pendingAutoParams) return;
    if (!window.electronAPI.onDouyinImportProgress) return;

    if (!mediaTaskIdRef.current) {
      mediaTaskIdRef.current = `media-import-${Date.now()}`;
      useTaskProgressStore.getState().startTask({
        id: mediaTaskIdRef.current,
        category: 'import',
        label: `步骤 1/6 · ${importStepLabel(mediaSourceTypeRef.current)}`,
        mode: 'determinate',
        progress: 0,
        phase: '准备',
        level: 2,
        canCancel: false,
      });
    }

    const off = window.electronAPI.onDouyinImportProgress((snapshot) => {
      const id = mediaTaskIdRef.current;
      if (!id) return;
      // 关键同步：把最新快照写回 script store。
      // 第三个 effect 依赖 useScriptStore(s => s.videoImportProgress?.status)
      // 判断导入是否 done；不同步的话 'done' 信号永远到不了,
      // useAIVideoWorkflow 不会起跑,overlay 会在 completeTask 后回落到
      // STEP_LABELS['idle']='准备中' 并卡死。
      useScriptStore.getState().setVideoImportProgress(snapshot);
      if (snapshot.status === 'error') {
        useTaskProgressStore.getState().failTask(id, snapshot.error ?? '媒体导入失败');
        useAIStore.getState().setWorkflow({
          step: 'error',
          progress: 0,
          stepLabel: '',
          error: snapshot.error ?? '媒体导入失败',
          failedStep: 'douyin_importing',
          canCancel: false,
        });
        return;
      }
      if (snapshot.status === 'done') {
        useTaskProgressStore.getState().updateTask(id, { progress: 100, phase: '完成' });
        useTaskProgressStore.getState().completeTask(id);
        return;
      }
      useTaskProgressStore.getState().updateTask(id, {
        progress: Math.min(99, Math.max(0, snapshot.progress)),
        phase: snapshot.stepLabel,
      });
    });
    return off;
  }, [source, pendingAutoParams]);

  // 起跑 useAIVideoWorkflow：
  // - text 分支立即起跑
  // - media 分支等待 videoImportProgress.status === 'done'
  useEffect(() => {
    if (startedRef.current) return;
    if (!pendingAutoParams || !projectDir) return;
    abortedRef.current = false; // 起跑前清理一次

    // 恢复场景：pendingAutoResumeStep 存在时从该阶段起跑；否则默认 script_generating
    const resumeStep = pendingAutoResumeStep;
    const startFrom = resumeStep ?? 'script_generating';

    if (source === 'text') {
      startedRef.current = true;
      void (async () => {
        // 两份都读一次（轻量 IO）：
        // - script_generating 阶段需要 original.md 作为输入
        // - 后续阶段需要 script.md 作为 scriptText
        const [original, scriptText] = await Promise.all([
          window.electronAPI
            .loadScriptFile(projectDir, 'original.md')
            .then((v) => v ?? ''),
          window.electronAPI
            .loadScriptFile(projectDir, 'script.md')
            .then((v) => v ?? ''),
        ]);
        if (abortedRef.current) return;
        await start(scriptText, {
          autoMode: true,
          autoParams: pendingAutoParams,
          originalText: original,
          startFromStep: startFrom,
        });
      })();
    } else if (source === 'media' && mediaImportStatus === 'done') {
      startedRef.current = true;
      void (async () => {
        const original =
          (await window.electronAPI.loadScriptFile(projectDir, 'original.md')) ?? '';
        if (abortedRef.current) return;
        await start('', {
          autoMode: true,
          autoParams: pendingAutoParams,
          originalText: original,
          startFromStep: 'script_generating',
        });
      })();
    }
  }, [
    pendingAutoParams,
    pendingAutoResumeStep,
    projectDir,
    source,
    mediaImportStatus,
    start,
  ]);

  // 监听完成 / 取消 → 跳页，同时清掉 pendingMediaImport（I-1）
  useEffect(() => {
    // handleCancel / jump 已经做过清理 + 跳页，避免双发
    if (abortedRef.current) return;
    if (workflow.step === 'done') {
      setPendingAutoParams(null);
      setPendingAutoResumeStep(null);
      useScriptStore.getState().setPendingMediaImport(null);
      useScriptStore.getState().clearVideoImportState();
      startedRef.current = false;
      abortedRef.current = true;
      setPage('editor');
    } else if (workflow.step === 'error' && workflow.error === '任务已取消') {
      setPendingAutoParams(null);
      setPendingAutoResumeStep(null);
      useScriptStore.getState().setPendingMediaImport(null);
      useScriptStore.getState().clearVideoImportState();
      startedRef.current = false;
      abortedRef.current = true;
      setPage('script-workbench');
    }
    // 真实错误（非取消）保持在 overlay 上由用户点击跳转
  }, [
    workflow.step,
    workflow.error,
    setPage,
    setPendingAutoParams,
    setPendingAutoResumeStep,
  ]);

  // 统一取消处理：导入前置阶段 useAIVideoWorkflow 还没起跑，cancel() 是 no-op，
  // 这里要主动取消导入任务，再清空所有 pending state 并打上 aborted 标记。
  const handleCancel = () => {
    // 先打 aborted 旗：cancel() 触发 workflow.error='任务已取消'，watch-effect 会复跑，
    // 此时通过 abortedRef 早退避免清理双发
    abortedRef.current = true;
    if (mediaTaskIdRef.current) {
      const task = useTaskProgressStore.getState().tasks.get(mediaTaskIdRef.current);
      if (task?.status === 'active') {
        useTaskProgressStore.getState().cancelTask(mediaTaskIdRef.current, '任务已取消');
      }
    }
    cancel();
    setPendingAutoParams(null);
    setPendingAutoResumeStep(null);
    useScriptStore.getState().setPendingMediaImport(null);
    useScriptStore.getState().clearVideoImportState();
    startedRef.current = false;
    mediaKickedRef.current = false;
    mediaTaskIdRef.current = null;
    setPage(workflow.step === 'production_running' ? 'director-workbench' : 'script-workbench');
  };

  // ── overlay 展示用：导入期间把 workflow.step 虚拟成 'douyin_importing' ──
  // 此时 useAIVideoWorkflow 还没 start（或刚 start 尚未推进到 tts），
  // workflow.step 是 'idle' 或 'script_generating'；我们用 mediaTask 的进度
  // 覆盖展示，并把总进度压缩到整体 1/6 桶内（6 个可视阶段）。
  const mediaPhase =
    source === 'media' &&
    (workflow.step === 'idle' || workflow.step === 'script_generating') &&
    mediaTask?.status === 'active';
  const effectiveStep: WorkflowStep = mediaPhase ? 'douyin_importing' : workflow.step;
  const effectiveProgress = mediaPhase && mediaTask
    ? Math.round((mediaTask.progress ?? 0) / 6)
    : (workflow.progress ?? 0);
  const effectiveLabel = mediaPhase && mediaTask
    ? `步骤 1/6 · ${importStepLabel(mediaSourceTypeRef.current)}${mediaTask.phase ? ` · ${mediaTask.phase}` : ''}`
    : workflow.stepLabel;

  return (
    <AutoRunOverlay
      step={effectiveStep}
      stepLabel={effectiveLabel}
      progress={effectiveProgress}
      canCancel={mediaPhase ? false : workflow.canCancel}
      error={
        workflow.step === 'error' && workflow.error && workflow.error !== '任务已取消'
          ? { message: workflow.error, failedStep: workflow.failedStep ?? 'arranging' }
          : null
      }
      onCancel={handleCancel}
      onJumpToScriptWorkbench={() => {
        setPendingAutoParams(null);
        setPendingAutoResumeStep(null);
        useScriptStore.getState().setPendingMediaImport(null);
        useScriptStore.getState().clearVideoImportState();
        startedRef.current = false;
        abortedRef.current = true;
        setPage('script-workbench');
      }}
      onJumpToDirector={() => {
        setPendingAutoParams(null);
        setPendingAutoResumeStep(null);
        useScriptStore.getState().setPendingMediaImport(null);
        useScriptStore.getState().clearVideoImportState();
        startedRef.current = false;
        abortedRef.current = true;
        useAIStore.getState().resetWorkflow();
        setPage('director-workbench');
      }}
      onJumpToEditor={() => {
        setPendingAutoParams(null);
        setPendingAutoResumeStep(null);
        useScriptStore.getState().setPendingMediaImport(null);
        useScriptStore.getState().clearVideoImportState();
        startedRef.current = false;
        abortedRef.current = true;
        if (workflow.step === 'animatic_review') {
          useAIStore.getState().resetWorkflow();
        }
        setPage('editor');
      }}
    />
  );
}
