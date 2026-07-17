import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSonarInboxStore, type SonarEnqueueInput } from '../electron/sonar/inbox-store';

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sonar-inbox-'));
  return { dir, file: path.join(dir, 'sonar-inbox.json') };
}

function sampleInput(over: Partial<SonarEnqueueInput> = {}): SonarEnqueueInput {
  return {
    source: 'douyin',
    awemeId: 'aweme-1',
    creatorId: 'creator-1',
    creatorName: '某博主',
    title: '一个视频标题',
    url: 'https://www.douyin.com/video/aweme-1',
    coverUrl: 'https://cdn/cover.jpg',
    publishedAt: 1_700_000_000_000,
    durationMs: 60_000,
    transcript: {
      fullText: '完整转录文本',
      srtText: '1\n00:00:00,000 --> 00:00:02,000\n完整转录文本\n',
      segments: [{ text: '完整转录文本', startMs: 0, endMs: 2000 }],
    },
    ...over,
  };
}

describe('SonarInboxStore', () => {
  let dir: string;
  let file: string;
  let clock = 1000;

  beforeEach(() => {
    const t = tmpFile();
    dir = t.dir;
    file = t.file;
    clock = 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mkStore = () =>
    createSonarInboxStore({ file, now: () => clock, newId: () => `id-${clock}` });

  it('enqueue 写入一条 pending 项并持久化', async () => {
    const store = mkStore();
    const res = await store.enqueue(sampleInput());
    expect(res.duplicate).toBe(false);
    expect(res.item.status).toBe('pending');
    expect(res.item.id).toBe('id-1000');
    expect(res.item.awemeId).toBe('aweme-1');
    expect(res.item.receivedAt).toBe(1000);

    // 新实例从同一文件应能读回
    const reopened = createSonarInboxStore({ file });
    const list = await reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('一个视频标题');
  });

  it('enqueue 同 awemeId 幂等去重，返回 duplicate', async () => {
    const store = mkStore();
    await store.enqueue(sampleInput());
    clock = 2000;
    const again = await store.enqueue(sampleInput({ title: '改了标题' }));
    expect(again.duplicate).toBe(true);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('一个视频标题'); // 不被覆盖
  });

  it('enqueue refresh 命中已有项时覆盖刷新并重置为 pending', async () => {
    const store = mkStore();
    const { item } = await store.enqueue(sampleInput());
    await store.markStatus(item.id, 'drafted', { projectPath: '/p/x' });
    clock = 9000;
    const res = await store.enqueue(
      sampleInput({ title: '新标题', transcript: { fullText: '新转录', srtText: 's2', segments: [] } }),
      { refresh: true },
    );
    expect(res.duplicate).toBe(false);
    expect(res.refreshed).toBe(true);
    expect(res.item.id).toBe(item.id); // 保留 id
    expect(res.item.status).toBe('pending'); // 重置
    expect(res.item.projectPath).toBeUndefined();
    expect(res.item.title).toBe('新标题'); // 覆盖
    expect(res.item.receivedAt).toBe(1000); // 保留
    expect(res.item.updatedAt).toBe(9000);
    expect(await store.list()).toHaveLength(1); // 不新增
  });

  it('list 按 publishedAt 倒序，同刻按 receivedAt', async () => {
    const store = mkStore();
    await store.enqueue(sampleInput({ awemeId: 'a1', publishedAt: 2_000 }));
    clock = 3000;
    await store.enqueue(sampleInput({ awemeId: 'a2', publishedAt: 1_000 }));
    clock = 4000;
    await store.enqueue(sampleInput({ awemeId: 'a3', publishedAt: 2_000 }));
    const list = await store.list();
    expect(list.map((i) => i.awemeId)).toEqual(['a3', 'a1', 'a2']);
  });

  it('markStatus 更新状态与补丁字段', async () => {
    const store = mkStore();
    const { item } = await store.enqueue(sampleInput());
    clock = 5000;
    const updated = await store.markStatus(item.id, 'drafted', {
      projectPath: '/projects/x',
    });
    expect(updated?.status).toBe('drafted');
    expect(updated?.projectPath).toBe('/projects/x');
    expect(updated?.updatedAt).toBe(5000);

    clock = 6000;
    const failed = await store.markStatus(item.id, 'failed', { error: '炸了' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('炸了');
  });

  it('markStatus 不存在的 id 返回 null', async () => {
    const store = mkStore();
    expect(await store.markStatus('nope', 'drafted')).toBeNull();
  });

  it('get / getByAweme', async () => {
    const store = mkStore();
    const { item } = await store.enqueue(sampleInput());
    expect((await store.get(item.id))?.awemeId).toBe('aweme-1');
    expect((await store.getByAweme('aweme-1'))?.id).toBe(item.id);
    expect(await store.get('missing')).toBeNull();
    expect(await store.getByAweme('missing')).toBeNull();
  });

  it('remove 删除项', async () => {
    const store = mkStore();
    const { item } = await store.enqueue(sampleInput());
    expect(await store.remove(item.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.remove(item.id)).toBe(false);
  });

  it('clear 清空全部并返回删除条数', async () => {
    const store = mkStore();
    await store.enqueue(sampleInput({ awemeId: 'aweme-1' }));
    await store.enqueue(sampleInput({ awemeId: 'aweme-2' }));
    expect(await store.list()).toHaveLength(2);
    expect(await store.clear()).toBe(2);
    expect(await store.list()).toHaveLength(0);
    // 清空已持久化：新实例从同一文件读回也是空
    expect(await createSonarInboxStore({ file }).list()).toHaveLength(0);
    // 再次清空空箱返回 0
    expect(await store.clear()).toBe(0);
  });

  it('文件损坏/缺失时降级为空列表', async () => {
    writeFileSync(file, '{ this is not json', 'utf-8');
    const store = createSonarInboxStore({ file });
    expect(await store.list()).toEqual([]);
    // 仍可正常写入
    const res = await store.enqueue(sampleInput());
    expect(res.duplicate).toBe(false);
  });
});
