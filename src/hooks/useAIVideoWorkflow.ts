import { useAIStore } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { useWorkflowControls } from './ai-video-workflow/use-controls';

/** 统一取消入口，避免把用户主动停止误报为失败。 */
function cancelWorkflowTask(taskId: string, reason = '任务已取消'): void {
  const store = useTaskProgressStore.getState();
  const existing = store.tasks.get(taskId);
  if (!existing || existing.status !== 'active') return;
  store.cancelTask(taskId, reason);
}

export function useAIVideoWorkflow() {
  const workflow = useAIStore((state) => state.workflow);
  const setWorkflow = useAIStore((state) => state.setWorkflow);
  const resetWorkflow = useAIStore((state) => state.resetWorkflow);
  return {
    ...useWorkflowControls(
      workflow.step, setWorkflow, resetWorkflow, cancelWorkflowTask,
    ),
    workflow,
  };
}
