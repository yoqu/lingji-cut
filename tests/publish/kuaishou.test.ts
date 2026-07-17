import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import {
  buildKuaishouCaptionPlan,
  uploadKuaishouVideo,
} from '../../electron/publish/platforms/kuaishou';
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
    fill: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    isVisible: vi.fn().mockResolvedValue(false),
    getAttribute: vi.fn().mockResolvedValue(''),
    textContent: vi.fn().mockResolvedValue(''),
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
    waitForResponse: vi.fn().mockRejectedValue(new Error('no submit response')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    // waitForEvent('filechooser') → resolves with mockFileChooser
    waitForEvent: vi.fn().mockResolvedValue(mockFileChooser),
    evaluate: vi.fn().mockResolvedValue(true),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
    url: vi.fn().mockReturnValue('https://cp.kuaishou.com/article/publish/video'),
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

function makeSubmitResponse(body: Record<string, unknown>, status = 200) {
  return {
    url: () => 'https://cp.kuaishou.com/rest/cp/works/v2/video/pc/submit',
    status: () => status,
    statusText: () => (status === 200 ? 'OK' : 'Bad Request'),
    ok: () => status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
    request: () => ({ method: () => 'POST' }),
  };
}

it('快手文案中的已有话题与独立标签统一去重，并将总数限制为 3', () => {
  expect(
    buildKuaishouCaptionPlan('正文 #比亚迪 #储能 #隐形冠军', [
      '比亚迪',
      '储能',
      '充电桩',
    ]),
  ).toEqual({
    description: '正文 #比亚迪 #储能 #隐形冠军',
    tagsToAppend: [],
  });
  expect(buildKuaishouCaptionPlan('正文 #甲 #乙 #丙 #丁', [])).toEqual({
    description: '正文 #甲 #乙 #丙',
    tagsToAppend: [],
  });
});

// existsSync 门槛要求封面文件真实存在
const REAL_COVER = join(tmpdir(), 'ks-test-cover-3x4.png');
writeFileSync(REAL_COVER, 'png');

it(
  '提供 covers 3:4 时优先用它设置封面（setInputFiles 收到竖图路径）',
  async () => {
    const page = makeMockPage();
    const sharedLocator = page.locator('x');

    await uploadKuaishouVideo(page as any, {
      ...UPLOAD_OPTS,
      thumbnail: '/tmp/fallback-16x9.jpg',
      covers: { '3:4': REAL_COVER },
    } as any);

    expect(sharedLocator.setInputFiles).toHaveBeenCalledWith(REAL_COVER);
  },
  15_000,
);

it(
  '封面文件不存在 → 不碰封面弹窗（避免残留弹窗卡死页面），经 onProgress 外发原因',
  async () => {
    const page = makeMockPage();
    const sharedLocator = page.locator('x');
    const onProgress = vi.fn();

    await uploadKuaishouVideo(page as any, {
      ...UPLOAD_OPTS,
      thumbnail: '/tmp/definitely-not-exists-cover.png',
      onProgress,
    } as any);

    expect(sharedLocator.setInputFiles).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(
      80,
      expect.stringMatching(/快手封面文件不存在/),
    );
  },
  15_000,
);

it(
  '封面设置两轮均失败 → 硬摘残留弹窗 + 经 onProgress 外发原因并继续发布（不静默吞掉、不中断）',
  async () => {
    const page = makeMockPage();
    const sharedLocator = page.locator('x');
    sharedLocator.setInputFiles.mockRejectedValue(new Error('cover input not found'));
    const onProgress = vi.fn();

    await uploadKuaishouVideo(page as any, {
      ...UPLOAD_OPTS,
      thumbnail: REAL_COVER,
      onProgress,
    } as any);

    expect(onProgress).toHaveBeenCalledWith(
      80,
      expect.stringMatching(/快手封面设置失败.*cover input not found/),
    );
    // 失败路径必须执行过弹窗摘除（page.evaluate 被调用以移除 ant-modal-wrap）
    const evaluateCalls = page.evaluate.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(evaluateCalls.some((code: string) => code.includes('ant-modal-wrap'))).toBe(true);
  },
  15_000,
);

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

it('作者声明为空时选择“个人观点，仅供参考”后再发布', async () => {
  const page = makeMockPage();
  const sharedLocator = page.locator('x');
  const selectedItem = {
    ...sharedLocator,
    count: vi.fn().mockResolvedValue(0),
  };
  const declarationSelect: any = {
    ...sharedLocator,
    count: vi.fn().mockResolvedValue(1),
    click: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((sel: string) =>
      sel === '.ant-select-selection-item' ? selectedItem : sharedLocator,
    ),
  };
  declarationSelect.first = () => declarationSelect;
  const declarationRow: any = {
    ...sharedLocator,
    locator: vi.fn((sel: string) => (sel === '.ant-select' ? declarationSelect : sharedLocator)),
  };
  const declarationLabel: any = {
    ...sharedLocator,
    count: vi.fn().mockResolvedValue(1),
    locator: vi.fn((sel: string) => (sel === 'xpath=..' ? declarationRow : sharedLocator)),
  };
  declarationLabel.first = () => declarationLabel;
  const declarationOption: any = {
    ...sharedLocator,
    count: vi.fn().mockResolvedValue(1),
    click: vi.fn().mockResolvedValue(undefined),
  };
  declarationOption.first = () => declarationOption;
  page.getByText = vi.fn((text: string) => {
    if (text === '作者声明') return declarationLabel;
    if (text === '个人观点，仅供参考') return declarationOption;
    return sharedLocator;
  });

  await uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);

  expect(declarationSelect.click).toHaveBeenCalled();
  expect(declarationOption.click).toHaveBeenCalled();
}, 10_000);

it('发布成功按作品管理路径判断，不依赖查询参数及顺序', async () => {
  const page = makeMockPage();
  page.waitForURL = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async (matcher: unknown) => {
      expect(matcher).toBeTypeOf('function');
      const matches = matcher as (url: URL) => boolean;
      expect(matches(new URL('https://cp.kuaishou.com/article/manage/video'))).toBe(true);
      expect(
        matches(new URL('https://cp.kuaishou.com/article/manage/video?from=publish&status=2')),
      ).toBe(true);
      expect(matches(new URL('https://evil.example/article/manage/video'))).toBe(false);
      expect(matches(new URL('https://cp.kuaishou.com/article/publish/video'))).toBe(false);
    });

  await uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);
});

it('提交接口明确拒绝时立即返回快手原始错误和安全诊断信息', async () => {
  vi.useFakeTimers();
  try {
    const page = makeMockPage();
    page.waitForURL = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('nav timeout'));
    page.waitForResponse.mockResolvedValue(
      makeSubmitResponse({ result: 0, originResult: 24601, message: '作品描述暂不支持发布' }),
    );

    const promise = uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);
    const assertion = expect(promise).rejects.toThrow(
      /快手发布失败：作品描述暂不支持发布.*http=200.*result=0.*originResult=24601/,
    );
    await vi.runAllTimersAsync();
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it('提交接口已确认成功但前端未跳转时仍按发布成功处理，避免重复提交', async () => {
  vi.useFakeTimers();
  try {
    const page = makeMockPage();
    page.waitForURL = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('nav timeout'));
    page.waitForResponse.mockResolvedValue(
      makeSubmitResponse({ result: 1, message: '发布成功' }),
    );

    const promise = uploadKuaishouVideo(page as any, UPLOAD_OPTS as any);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

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
