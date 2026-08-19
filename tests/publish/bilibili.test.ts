import { it, expect } from 'vitest';
import {
  BILIUP_DEFAULT_LINE,
  buildBiliupUploadArgs,
  formatBiliupUploadError,
  isBiliupUploadLineRetryable,
} from '../../electron/publish/platforms/bilibili';

it('upload 参数含 -u/upload/--tid/--tag 且顺序匹配源', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: ['a', 'b'],
    tid: 21,
    headless: true,
  } as any);
  // -u <accountFile> upload <videoFile> is the leading structure
  expect(args.slice(0, 3)).toEqual(['-u', '/c/bili.json', 'upload']);
  expect(args).toContain('/v.mp4');
  // --title, --desc, --tid, --tag must all be present
  expect(args).toEqual(
    expect.arrayContaining(['--title', 'T', '--desc', 'D', '--tid', '21', '--line', 'bda2', '--tag', 'a,b']),
  );
});

it('默认上传线路为 bda2，避免 biliup 探测到证书过期的 bldsa', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: [],
    tid: 21,
    headless: true,
  } as any);
  expect(BILIUP_DEFAULT_LINE).toBe('bda2');
  const idx = args.indexOf('--line');
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe('bda2');
});

it('可覆盖上传线路', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: [],
    tid: 21,
    headless: true,
  } as any, 'tx');
  expect(args[args.indexOf('--line') + 1]).toBe('tx');
});

it('covers 16:9 优先作为 --cover', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: [],
    tid: 21,
    headless: true,
    covers: { '16:9': '/cover-wide.png', '4:3': '/cover-43.png' },
    thumbnail: '/thumb.png',
  } as any);
  const idx = args.indexOf('--cover');
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe('/cover-wide.png');
});

it('缺 16:9 时回退 4:3，再回退 thumbnail', () => {
  const only43 = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json', filePath: '/v.mp4', title: 'T', desc: 'D',
    tags: [], tid: 21, headless: true, covers: { '4:3': '/cover-43.png' },
  } as any);
  expect(only43[only43.indexOf('--cover') + 1]).toBe('/cover-43.png');

  const onlyThumb = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json', filePath: '/v.mp4', title: 'T', desc: 'D',
    tags: [], tid: 21, headless: true, thumbnail: '/thumb.png',
  } as any);
  expect(onlyThumb[onlyThumb.indexOf('--cover') + 1]).toBe('/thumb.png');
});

it('无封面时不含 --cover', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json', filePath: '/v.mp4', title: 'T', desc: 'D',
    tags: [], tid: 21, headless: true,
  } as any);
  expect(args).not.toContain('--cover');
});

it('无 tags 时不含 --tag', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: [],
    tid: 21,
    headless: true,
  } as any);
  expect(args).not.toContain('--tag');
});

it('scheduleAt 会产生 --dtime（秒级）', () => {
  const ts = 1_700_000_000_000; // milliseconds
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'T',
    desc: 'D',
    tags: [],
    tid: 17,
    headless: true,
    scheduleAt: ts,
  } as any);
  const idx = args.indexOf('--dtime');
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe(String(Math.floor(ts / 1000)));
});

it('完整 argv 顺序与源一致 (title→desc→tid→line→tag)', () => {
  const args = buildBiliupUploadArgs('/c/bili.json', {
    storageStatePath: '/c/bili.json',
    filePath: '/v.mp4',
    title: 'MyTitle',
    desc: 'MyDesc',
    tags: ['x'],
    tid: 99,
    headless: true,
  } as any);
  // Expected shape: [-u, file, upload, video, --title, ..., --desc, ..., --tid, ..., --line, ..., --tag, ...]
  const titleIdx = args.indexOf('--title');
  const descIdx = args.indexOf('--desc');
  const tidIdx = args.indexOf('--tid');
  const lineIdx = args.indexOf('--line');
  const tagIdx = args.indexOf('--tag');
  expect(titleIdx).toBeGreaterThan(-1);
  expect(descIdx).toBeGreaterThan(titleIdx);
  expect(tidIdx).toBeGreaterThan(descIdx);
  expect(lineIdx).toBeGreaterThan(tidIdx);
  expect(tagIdx).toBeGreaterThan(lineIdx);
  expect(args[titleIdx + 1]).toBe('MyTitle');
  expect(args[descIdx + 1]).toBe('MyDesc');
  expect(args[tidIdx + 1]).toBe('99');
  expect(args[lineIdx + 1]).toBe('bda2');
  expect(args[tagIdx + 1]).toBe('x');
});

it('证书/连接错误可换线路重试，业务错误不重试', () => {
  expect(isBiliupUploadLineRetryable(
    'invalid peer certificate: Other(OtherError("*.bilivideo.com" certificate is expired: -67818"))',
  )).toBe(true);
  expect(isBiliupUploadLineRetryable('Request failed after 5 retries')).toBe(true);
  expect(isBiliupUploadLineRetryable('B站上传必须指定分区 id')).toBe(false);
});

it('证书过期错误转成可读中文', () => {
  const msg = formatBiliupUploadError(
    'invalid peer certificate: “*.bilivideo.com” certificate is expired: -67818',
    ['bda2', 'tx'],
  );
  expect(msg).toContain('证书无效');
  expect(msg).toContain('bda2/tx');
});
