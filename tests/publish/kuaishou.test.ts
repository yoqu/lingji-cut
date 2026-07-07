import { it, expect, vi } from 'vitest';
import { uploadKuaishouVideo } from '../../electron/publish/platforms/kuaishou';
import { LoginExpiredError } from '../../electron/publish/errors';

/**
 * Mock page where every page.locator() / getByText() / getByRole() returns the same
 * sharedLocator so we can verify the upload flow in isolation.
 *
 * Key mock values chosen to make all upload-flow loops terminate immediately:
 *   count()           → 0   ("上传中" absent → upload-wait loop breaks; publish count=0 but
 *                             waitForURL resolves so publish loop breaks)
 *   isVisible()       → false (guide overlay / know-button absent)
 *   waitFor()         → resolves (upload button found, modal waits succeed)
 *   waitForURL()      → resolves (publish loop breaks on first iteration)
 *   waitForEvent()    → resolves with mockFileChooser (file chooser obtained)
 *   mockFileChooser.setFiles → spy (the assertion target)
 */
function makeMockPage() {
  const mockFileChooser = {
    setFiles: vi.fn().mockResolvedValue(undefined),
  };

  const sharedLocator: any = {
    click: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    isVisible: vi.fn().mockResolvedValue(false),
    getAttribute: vi.fn().mockResolvedValue(''),
    getByText: vi.fn(),
    getByRole: vi.fn(),
    locator: vi.fn(),
    filter: vi.fn(),
    nth: vi.fn(),
  };
  // Self-referential so chaining always returns sharedLocator
  sharedLocator.first = () => sharedLocator;
  sharedLocator.getByText = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.getByRole = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.locator = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.filter = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.nth = vi.fn().mockReturnValue(sharedLocator);

  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(sharedLocator),
    getByText: vi.fn().mockReturnValue(sharedLocator),
    getByRole: vi.fn().mockReturnValue(sharedLocator),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    // waitForEvent('filechooser') → resolves with mockFileChooser
    waitForEvent: vi.fn().mockResolvedValue(mockFileChooser),
    evaluate: vi.fn().mockResolvedValue(true),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
    url: vi.fn().mockReturnValue('https://cp.kuaishou.com/article/manage/video'),
    frames: vi.fn().mockReturnValue([]),
    // Expose mockFileChooser so the assertion can reach it
    _mockFileChooser: mockFileChooser,
  };

  return page;
}

it(
  'uploadKuaishouVideo 把视频文件设置到文件选择器上',
  async () => {
    const page = makeMockPage();

    await uploadKuaishouVideo(page as any, {
      storageStatePath: '/c.json',
      filePath: '/tmp/v.mp4',
      title: '标题',
      desc: '描述',
      tags: [], // empty → no per-tag sleep
      headless: true,
    });

    // uploadKuaishouVideo uses page.waitForEvent('filechooser') → fileChooser.setFiles(filePath)
    // (port of: async with page.expect_file_chooser() / file_chooser.set_files(self.file_path))
    expect(page._mockFileChooser.setFiles).toHaveBeenCalledWith('/tmp/v.mp4');
  },
  10_000, // 10s timeout: real sleep(2000) + sleep(1000) in publish loop
);

const UPLOAD_OPTS = {
  storageStatePath: '/c.json',
  filePath: '/tmp/v.mp4',
  title: '标题',
  desc: '描述',
  tags: [],
  headless: true,
} as const;

it('上传按钮超时且页面呈未登录态（机构服务标记存在）→ 抛 LoginExpiredError', async () => {
  const page = makeMockPage();
  // 上传按钮 waitFor 超时（快手未登录时 URL 不变，渲染成介绍页，按钮永不出现）
  page.locator('x').waitFor.mockRejectedValue(
    new Error("locator.waitFor: Timeout 10000ms exceeded"),
  );
  // waitForSelector 默认 resolve → 「机构服务」未登录标记存在

  await expect(uploadKuaishouVideo(page as any, UPLOAD_OPTS as any)).rejects.toBeInstanceOf(
    LoginExpiredError,
  );
});

it('新版描述编辑器 #work-description-edit 存在时优先点击它填写描述', async () => {
  const page = makeMockPage();
  const sharedLocator = page.locator('x');
  // 专用 desc 编辑器 locator：count=1 表示新版结构存在
  const descLocator: any = {
    ...sharedLocator,
    count: vi.fn().mockResolvedValue(1),
    click: vi.fn().mockResolvedValue(undefined),
  };
  page.locator = vi.fn((sel: string) =>
    sel === '#work-description-edit' ? descLocator : sharedLocator,
  );

  await uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);

  expect(descLocator.click).toHaveBeenCalled();
}, 10_000);

it('发布点击后始终未跳转到管理页 → 有界超时抛错而非无限挂起', async () => {
  vi.useFakeTimers();
  try {
    const page = makeMockPage();
    // 首次 waitForURL（进上传页）成功，发布循环里的 waitForURL 永远失败
    page.waitForURL = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('nav timeout'));

    const promise = uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);
    // 报错必须携带现场证据（最后一轮异常），便于远程诊断
    const assertion = expect(promise).rejects.toThrow(/快手发布确认超时.*最后一轮异常/);
    await vi.runAllTimersAsync();
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it('上传按钮超时但未登录标记不存在（页面结构变化）→ 原样抛出超时错误', async () => {
  const page = makeMockPage();
  page.locator('x').waitFor.mockRejectedValue(
    new Error("locator.waitFor: Timeout 10000ms exceeded"),
  );
  // 「机构服务」标记不存在 → waitForSelector 超时 reject
  page.waitForSelector.mockRejectedValue(new Error('waitForSelector: Timeout 5000ms exceeded'));

  await expect(uploadKuaishouVideo(page as any, UPLOAD_OPTS as any)).rejects.toThrow(
    'locator.waitFor: Timeout 10000ms exceeded',
  );
});
