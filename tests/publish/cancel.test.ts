import { describe, it, expect, vi } from 'vitest';
import {
  registerPublishCancelHandler,
  abortActivePublish,
} from '../../electron/publish/cancel';
import { withContext } from '../../electron/publish/engine';

describe('publish cancel registry', () => {
  it('abortActivePublish 调用并清空所有已注册句柄', async () => {
    const a = vi.fn();
    const b = vi.fn(async () => {});
    registerPublishCancelHandler(a);
    registerPublishCancelHandler(b);

    await abortActivePublish();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // 已清空：再次 abort 不重复调用
    await abortActivePublish();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('注销后 abort 不再触发句柄', async () => {
    const h = vi.fn();
    const unregister = registerPublishCancelHandler(h);
    unregister();
    await abortActivePublish();
    expect(h).not.toHaveBeenCalled();
  });
});

describe('withContext 取消联动', () => {
  it('abortActivePublish 关闭 in-flight 浏览器使上传报错退出', async () => {
    let rejectRun: (err: Error) => void = () => {};
    const newContext = vi.fn().mockResolvedValue({
      addInitScript: vi.fn(),
      close: vi.fn(),
    });
    const browser = {
      newContext,
      close: vi.fn(async () => rejectRun(new Error('Target closed'))),
    };
    const fakePlaywright = { chromium: { launch: vi.fn().mockResolvedValue(browser) } };

    const pending = withContext(
      { headless: true },
      () => new Promise<never>((_, reject) => { rejectRun = reject; }),
      fakePlaywright as never,
    );
    // 等 launch/newContext 完成进入 run
    await new Promise((r) => setTimeout(r, 0));

    await abortActivePublish();
    await expect(pending).rejects.toThrow('Target closed');
    expect(browser.close).toHaveBeenCalled();
  });

  it('正常完成后句柄已注销，abort 不再关闭浏览器', async () => {
    const newContext = vi.fn().mockResolvedValue({ addInitScript: vi.fn(), close: vi.fn() });
    const browser = { newContext, close: vi.fn() };
    const fakePlaywright = { chromium: { launch: vi.fn().mockResolvedValue(browser) } };

    await withContext({ headless: true }, async () => 'ok', fakePlaywright as never);
    const closes = browser.close.mock.calls.length;
    await abortActivePublish();
    expect(browser.close).toHaveBeenCalledTimes(closes);
  });
});
