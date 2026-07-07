// tests/cli-endpoint.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveEndpoint } from '../cli/src/endpoint';

describe('resolveEndpoint', () => {
  it('prefers --server flag and normalizes legacy suffixes', () => {
    expect(resolveEndpoint({ serverFlag: 'http://127.0.0.1:9000/', env: {}, endpointFile: '/no' }).url)
      .toBe('http://127.0.0.1:9000');
    expect(resolveEndpoint({ serverFlag: 'http://127.0.0.1:9000/mcp', env: {}, endpointFile: '/no' }).url)
      .toBe('http://127.0.0.1:9000');
    expect(resolveEndpoint({ serverFlag: 'http://127.0.0.1:9000/invoke', env: {}, endpointFile: '/no' }).url)
      .toBe('http://127.0.0.1:9000');
  });

  it('falls back to LINGJI_CONTROL_URL / LINGJI_CONTROL_TOKEN env', () => {
    const ep = resolveEndpoint({
      env: { LINGJI_CONTROL_URL: 'http://h:1', LINGJI_CONTROL_TOKEN: 'tk-env' },
      endpointFile: '/no',
    });
    expect(ep.url).toBe('http://h:1');
    expect(ep.token).toBe('tk-env');
  });

  it('reads url and token from endpoint file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-rf-'));
    const file = path.join(dir, 'control-endpoint.json');
    try {
      writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:7777', port: 7777, token: 'tk-file' }));
      const ep = resolveEndpoint({ env: {}, endpointFile: file });
      expect(ep.url).toBe('http://127.0.0.1:7777');
      expect(ep.token).toBe('tk-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--token flag beats env and file token', () => {
    const ep = resolveEndpoint({
      tokenFlag: 'tk-flag',
      env: { LINGJI_CONTROL_TOKEN: 'tk-env' },
      endpointFile: '/no',
    });
    expect(ep.token).toBe('tk-flag');
  });

  it('defaults to 19820 base url with no token when nothing else resolves', () => {
    const ep = resolveEndpoint({ env: {}, endpointFile: '/definitely/missing' });
    expect(ep.url).toBe('http://127.0.0.1:19820');
    expect(ep.token).toBeUndefined();
  });
});
