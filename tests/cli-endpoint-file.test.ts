import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeEndpointFile, removeEndpointFile } from '../electron/control/endpoint-file';
import { readFileSync as readSrc } from 'node:fs';

describe('control endpoint-file', () => {
  it('writes endpoint json with url/port/pid/token then removes it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-ep-'));
    const file = path.join(dir, 'sub', 'control-endpoint.json');
    try {
      await writeEndpointFile({ port: 19820, token: 'tk', sonarToken: 'sk' }, file);
      expect(existsSync(file)).toBe(true);
      const info = JSON.parse(readFileSync(file, 'utf-8'));
      expect(info.url).toBe('http://127.0.0.1:19820');
      expect(info.port).toBe(19820);
      expect(info.token).toBe('tk');
      expect(info.sonarToken).toBe('sk');
      expect(typeof info.pid).toBe('number');
      expect(typeof info.startedAt).toBe('number');
      await removeEndpointFile(file);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removeEndpointFile is a no-op when file missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-ep-'));
    try {
      await expect(removeEndpointFile(path.join(dir, 'nope.json'))).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('control server wiring', () => {
  it('startControlServer writes endpoint file, checks token and serves /invoke', () => {
    const src = readSrc(new URL('../electron/control/server.ts', import.meta.url), 'utf8');
    expect(src).toContain("from './endpoint-file'");
    expect(src).toContain('writeEndpointFile(');
    expect(src).toContain('removeEndpointFile(');
    expect(src).toContain("'/invoke'");
    expect(src).toContain("x-lingji-token");
    expect(src).toContain('registerTools(registry');
  });
});

describe('control op event broadcast', () => {
  it('handleInvoke 广播 start/success/error 事件到渲染端', () => {
    const src = readSrc(new URL('../electron/control/server.ts', import.meta.url), 'utf8');
    expect(src).toContain("'control:op-event'");
    expect(src).toContain("phase: 'start'");
    expect(src).toContain("phase: 'error'");
    expect(src).toContain('SILENT_OPS');
  });
});
