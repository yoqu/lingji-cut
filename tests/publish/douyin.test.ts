import { it, expect, vi } from 'vitest';
import { uploadDouyinVideo } from '../../electron/publish/platforms/douyin';

/**
 * Mock page where every page.locator() / getByRole() / getByText() returns the SAME
 * sharedLocator object so we can spy on setInputFiles across all selector calls.
 */
function makeMockPage() {
  const sharedLocator: any = {
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    // count() returns 1 so:
    //   • "[class^='long-card'] div:has-text('重新上传')" → n=1 → upload-complete loop breaks
    //   • publishButton.count() → 1 → click it
    //   • third-part element count → 1 → evaluate className
    count: vi.fn().mockResolvedValue(1),
    isVisible: vi.fn().mockResolvedValue(false),
    // evaluate() returns '' → no 'semi-switch-checked' → enters switch click branch
    evaluate: vi.fn().mockResolvedValue(''),
    getAttribute: vi.fn().mockResolvedValue(null),
    innerText: vi.fn().mockResolvedValue(''),
  };
  // All chained locator methods return the same mock object
  sharedLocator.first = () => sharedLocator;
  sharedLocator.nth = () => sharedLocator;
  sharedLocator.locator = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.getByText = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.getByRole = vi.fn().mockReturnValue(sharedLocator);
  sharedLocator.filter = vi.fn().mockReturnValue(sharedLocator);

  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    // All locator calls return the shared locator so we can assert on setInputFiles
    locator: vi.fn().mockReturnValue(sharedLocator),
    getByRole: vi.fn().mockReturnValue(sharedLocator),
    getByText: vi.fn().mockReturnValue(sharedLocator),
    getByPlaceholder: vi.fn().mockReturnValue(sharedLocator),
    // waitForURL always resolves → publish-page loop and manage-URL loop both break immediately
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    // waitForSelector resolves → file input "attached" check passes
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evalOnSelector: vi.fn().mockResolvedValue(''),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
    // url() returns a creator-micro URL (not used in uploadDouyinVideo directly,
    // but guards _isLoginCompleted if ever called from upload context)
    url: vi.fn().mockReturnValue(
      'https://creator.douyin.com/creator-micro/content/manage',
    ),
    _sharedLocator: sharedLocator,
  };

  return page;
}

it('uploadDouyinVideo 把视频文件设置到 div[class^="container"] input 上', async () => {
  const page = makeMockPage();

  await uploadDouyinVideo(page as any, {
    storageStatePath: '/c.json',
    filePath: '/tmp/v.mp4',
    title: '标题',
    desc: '描述',
    tags: ['a', 'b'],
    headless: true,
  });

  // The upload code calls:
  //   page.locator("div[class^='container'] input").setInputFiles(opts.filePath)
  // sharedLocator is the object returned by every page.locator() call, so we can
  // verify setInputFiles was called with the correct path.
  const { _sharedLocator: loc } = page;
  expect(loc.setInputFiles).toHaveBeenCalledWith('/tmp/v.mp4');
});

it('uploadDouyinVideo 把描述打入描述编辑器（先描述后标签）', async () => {
  const page = makeMockPage();

  await uploadDouyinVideo(page as any, {
    storageStatePath: '/c.json',
    filePath: '/tmp/v.mp4',
    title: '标题',
    desc: '这是视频描述',
    tags: ['a'],
    headless: true,
  });

  const typed = page.keyboard.type.mock.calls.map((c: any[]) => c[0]);
  const descIndex = typed.indexOf('这是视频描述');
  const tagIndex = typed.findIndex((t: string) => t.includes('#a'));
  expect(descIndex).toBeGreaterThanOrEqual(0);
  expect(tagIndex).toBeGreaterThan(descIndex);
});

it('uploadDouyinVideo 传入 covers 时上传 3:4 竖封面 + 4:3 横封面', async () => {
  const page = makeMockPage();

  await uploadDouyinVideo(page as any, {
    storageStatePath: '/c.json',
    filePath: '/tmp/v.mp4',
    title: '标题',
    desc: '描述',
    tags: [],
    covers: { '3:4': '/port.png', '4:3': '/land.png' },
    headless: true,
  });

  const { _sharedLocator: loc } = page;
  expect(loc.setInputFiles).toHaveBeenCalledWith('/port.png'); // 竖封面 3:4
  expect(loc.setInputFiles).toHaveBeenCalledWith('/land.png'); // 横封面 4:3
}, 20_000); // _setThumbnail 含真实 sleep（两张封面约 9s），放宽超时
