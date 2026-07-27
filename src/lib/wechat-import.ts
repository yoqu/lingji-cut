import { useTaskProgressStore } from '../store/task-progress';
import type { WechatArticleMeta } from './article-import-types';

export interface WechatMaterializeInput {
  projectDir: string;
  articleId: string;
  meta: WechatArticleMeta;
  markdown: string;
}

/**
 * 公众号文章落地（图片下载 + 链接改写），接入底部统一进度条。
 * 返回图片链接已改写为项目相对路径的最终 Markdown。
 */
export async function materializeWechatArticleWithProgress(
  input: WechatMaterializeInput,
): Promise<string> {
  const taskId = `wechat-import-${Date.now()}`;
  const store = useTaskProgressStore.getState();
  store.startTask({
    id: taskId,
    category: 'import',
    label: '导入公众号文章',
    mode: 'determinate',
    progress: 0,
    phase: '正在下载文章图片',
    level: 2,
    canCancel: false,
  });
  const unsubscribe = window.electronAPI.onWechatArticleProgress(({ progress, stepLabel }) => {
    useTaskProgressStore.getState().updateTask(taskId, { progress, phase: stepLabel });
  });
  try {
    const result = await window.electronAPI.materializeWechatArticle(input);
    useTaskProgressStore.getState().completeTask(taskId);
    return result.markdown;
  } catch (error) {
    const message = error instanceof Error ? error.message : '公众号文章导入失败';
    useTaskProgressStore.getState().failTask(taskId, message);
    throw error;
  } finally {
    unsubscribe();
  }
}
