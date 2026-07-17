import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSunoApiProvider } from '../src/lib/audio-gen/sunoapi';
import { DEFAULT_SUNO_CALLBACK_URL } from '../src/lib/audio-gen/settings';

const config = {
  baseUrl: 'https://api.sunoapi.org',
  apiKey: 'secret',
  callbackUrl: 'https://relay.example/callback',
  musicModel: 'V5' as const,
};

afterEach(() => vi.unstubAllGlobals());

describe('SunoApiProvider', () => {
  it('使用纯音乐自定义模式创建播客 BGM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      msg: 'success',
      data: { taskId: 'task-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const task = await createSunoApiProvider(config).createMusic({
      title: '主 BGM',
      style: '克制的知识播客背景音乐',
    });

    expect(task).toEqual({ taskId: 'task-1', kind: 'music' });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      customMode: true,
      instrumental: true,
      model: 'V5',
      callBackUrl: config.callbackUrl,
    });
    expect(body.negativeTags).toContain('vocals');
  });

  it('未配置 callback 时补入内置回调入口并继续使用主动轮询', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      msg: 'success',
      data: { taskId: 'task-polling' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await createSunoApiProvider({ ...config, callbackUrl: '' }).createMusic({
      title: '轮询 BGM',
      style: 'restrained instrumental underscore',
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.callBackUrl).toBe(DEFAULT_SUNO_CALLBACK_URL);
  });

  it('创建短音效时始终携带 callback 并固定使用 V5', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      msg: 'success',
      data: { taskId: 'sound-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const task = await createSunoApiProvider(config).createSound({
      prompt: 'short UI chime',
      soundLoop: false,
    });

    expect(task).toEqual({ taskId: 'sound-1', kind: 'sound' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      prompt: 'short UI chime',
      model: 'V5',
      callBackUrl: config.callbackUrl,
    });
  });

  it('兼容任务查询的 camelCase 返回并映射完成状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: {
        taskId: 'task-2',
        status: 'SUCCESS',
        response: {
          sunoData: [{ id: 'a1', audioUrl: 'https://cdn.example/a.mp3', duration: 183.2 }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const status = await createSunoApiProvider(config).getMusicTask('task-2');
    expect(status.state).toBe('succeeded');
    expect(status.candidates[0]).toMatchObject({
      id: 'a1',
      audioUrl: 'https://cdn.example/a.mp3',
      durationSeconds: 183.2,
    });
  });

  it('积分不足不重试并保留供应商错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 429,
      msg: '积分不足',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSunoApiProvider(config).getCredits()).rejects.toMatchObject({ code: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
