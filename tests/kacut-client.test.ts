import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KacutError,
  checkKacutHealth,
  getKacutLibraryDigest,
  isRetryableKacutError,
  makeKacutDigestProvider,
  searchKacutClips,
} from '../electron/footage/kacut-client';
import type { KacutClip } from '../src/types/footage';

const BASE = 'http://127.0.0.1:8765';
const TOKEN_ENDPOINT = `${BASE}/mcp?token=test-access-token`;
const MCP_CONFIG = JSON.stringify({
  mcpServers: { 'lingji-material': { url: TOKEN_ENDPOINT } },
});

function rpcResponse(payload: unknown, init?: { isError?: boolean }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: init?.isError ?? false,
      },
    }),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('kacut-client JSON-RPC 编解码', () => {
  it('search_clips 按契约编码请求并解码 content[0].text', async () => {
    const bodies: unknown[] = [];
    const clip: KacutClip = {
      id: 'c1',
      filename: 'city.mp4',
      path: '/library/city.mp4',
      kind: 'video',
      score: 0.82,
      matchedSegmentStart: 12.5,
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return rpcResponse({ clips: [clip] });
    }));

    const first = await searchKacutClips(BASE, { query: '城市夜景', kind: 'video', limit: 5 });
    const second = await searchKacutClips(`${BASE}/`, { query: '街道' });

    expect(first).toEqual([clip]);
    expect(second).toEqual([clip]);
    // JSON-RPC 2.0 契约：method=tools/call，params.name=工具名，id 递增
    const [req1, req2] = bodies as Array<Record<string, unknown>>;
    expect(req1.jsonrpc).toBe('2.0');
    expect(req1.method).toBe('tools/call');
    expect(req1.params).toEqual({
      name: 'search_clips',
      arguments: { query: '城市夜景', kind: 'video', limit: 5 },
    });
    expect(typeof req1.id).toBe('number');
    expect((req2.id as number) - (req1.id as number)).toBe(1);

    const urls = (vi.mocked(fetch).mock.calls as unknown as Array<[string]>).map(([url]) => url);
    expect(urls[0]).toBe(`${BASE}/mcp`);
    // baseUrl 尾部斜杠归一化，不产生双斜杠
    expect(urls[1]).toBe(`${BASE}/mcp`);
  });

  it('完整 token endpoint 与 mcpServers JSON 都直连 /mcp，不重复拼路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse([])));

    await searchKacutClips(TOKEN_ENDPOINT, { query: '城市' });
    await searchKacutClips(MCP_CONFIG, { query: '街道' });

    const urls = (vi.mocked(fetch).mock.calls as unknown as Array<[string]>).map(([url]) => url);
    expect(urls).toEqual([TOKEN_ENDPOINT, TOKEN_ENDPOINT]);
  });

  it('工具 isError 时抛带 kacut 前缀的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse('索引未就绪', { isError: true })));
    await expect(searchKacutClips(BASE, { query: 'x' })).rejects.toThrow(/^kacut /);
  });

  it('RPC error 字段与 HTTP 非 2xx 都归一为 KacutError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }),
    })));
    await expect(searchKacutClips(BASE, { query: 'x' })).rejects.toBeInstanceOf(KacutError);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    await expect(searchKacutClips(BASE, { query: 'x' })).rejects.toThrow(/kacut HTTP 503/);
  });

  it('clips 缺失 / 非数组按空结果处理；非法条目被过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({})));
    await expect(searchKacutClips(BASE, { query: 'x' })).resolves.toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({
      clips: [{ id: 'ok', path: '/a.mp4', kind: 'video', score: 0.9 }, { filename: '缺字段' }],
    })));
    const clips = await searchKacutClips(BASE, { query: 'x' });
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe('ok');
  });

  it('裸数组形状（KaCut server 实际返回）同样解码并过滤非法条目', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse([
      { id: 'ok', path: '/a.mp4', kind: 'video', score: 0.9 },
      { filename: '缺字段' },
    ])));
    const clips = await searchKacutClips(BASE, { query: 'x' });
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe('ok');
  });

  it('空 query 直接拒绝，不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(searchKacutClips(BASE, { query: '  ' })).rejects.toThrow(/kacut/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('kacut-client 超时与健康检查', () => {
  it('素材工具超时只发一次请求并暴露可延后重试语义', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const promise = searchKacutClips(BASE, { query: '慢查询' });
    const settled = promise.catch((reason) => reason);
    await vi.advanceTimersByTimeAsync(15_100);
    const error = await settled;
    expect(error).toBeInstanceOf(KacutError);
    expect(error.message).toMatch(/kacut 请求超时/);
    expect(isRetryableKacutError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('只把超时、网络和临时服务错误标记为可重试', () => {
    expect(isRetryableKacutError(new KacutError('请求失败：socket closed'))).toBe(true);
    expect(isRetryableKacutError(new KacutError('HTTP 503（search_clips）'))).toBe(true);
    expect(isRetryableKacutError(new KacutError('响应不是合法 JSON（search_clips）'))).toBe(false);
  });

  it('GET /mcp/health：{ok:true} 通过；非 2xx 与 ok!==true 抛错', async () => {
    const calls: Array<[string, RequestInit?]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));
    await expect(checkKacutHealth(BASE)).resolves.toBe(true);
    expect(calls[0][0]).toBe(`${BASE}/mcp/health`);
    expect(calls[0][1]?.method).toBe('GET');

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    await expect(checkKacutHealth(BASE)).rejects.toThrow(/kacut/);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false }),
    }) as Response));
    await expect(checkKacutHealth(BASE)).rejects.toThrow(/kacut/);
  });

  it('带 token 的 MCP endpoint 将查询参数保留到 /mcp/health', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));

    await expect(checkKacutHealth(MCP_CONFIG)).resolves.toBe(true);
    expect(calls).toEqual([`${BASE}/mcp/health?token=test-access-token`]);
  });

  it('网络错误不会把 token 带进错误消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`failed ${TOKEN_ENDPOINT}`);
    }));
    await expect(checkKacutHealth(TOKEN_ENDPOINT)).rejects.not.toThrow(/test-access-token/);
  });

  it('get_library_digest 返回摘要；缺 itemCount 视为格式非法', async () => {
    const digest = {
      libraryCount: 1,
      itemCount: 42,
      indexedItemCount: 40,
      kindCounts: { video: 30, image: 12 },
      topSceneTags: [{ tag: '城市', count: 9 }],
      sceneTagCatalog: [
        { tag: '城市', count: 9, kindCounts: { video: 7, image: 2 } },
        { tag: '道路', count: 6, kindCounts: { video: 6 } },
      ],
      libraries: [{ id: 'lib1', name: '默认库', itemCount: 42 }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse(digest)));
    await expect(getKacutLibraryDigest(BASE)).resolves.toEqual(digest);

    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({ libraryCount: 1 })));
    await expect(getKacutLibraryDigest(BASE)).rejects.toThrow(/kacut 素材库摘要格式非法/);
  });

  it('digest provider 不再吞掉连接错误，交给 planning 遥测记录具体原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    const provider = makeKacutDigestProvider({ kacut: { enabled: true, baseUrl: BASE } });
    await expect(provider()).rejects.toThrow(/kacut HTTP 503/);
  });
});
