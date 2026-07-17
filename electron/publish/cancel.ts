/**
 * 发布取消注册表。
 *
 * 取消 flag（ipc.ts）只能阻止「下一个账号」开始；正在执行的上传（Playwright
 * 浏览器自动化 / biliup 子进程）必须靠中断句柄强行关闭才能立即退出。
 * 资源启动时注册句柄、结束时注销；publish:cancel 统一触发 abortActivePublish。
 */
const handlers = new Set<() => void | Promise<void>>();

/** 注册中断句柄，返回注销函数（资源正常结束时调用）。 */
export function registerPublishCancelHandler(
  handler: () => void | Promise<void>,
): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** 中断所有 in-flight 发布资源；句柄一次性消费，异常忽略。 */
export async function abortActivePublish(): Promise<void> {
  const pending = [...handlers];
  handlers.clear();
  await Promise.allSettled(pending.map((h) => h()));
}
