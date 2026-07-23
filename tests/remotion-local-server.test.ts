import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { startRemotionLocalServer } from '../electron/remotion/local-server';

describe('Remotion local static server', () => {
  it('serves the bundle from an explicit IPv4 loopback URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lingji-remotion-server-test-'));
    await writeFile(path.join(root, 'index.html'), '<h1>offline</h1>');
    const server = await startRemotionLocalServer(root);
    try {
      expect(new URL(server.serveUrl).hostname).toBe('127.0.0.1');
      const response = await fetch(`${server.serveUrl}/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<h1>offline</h1>');

      await expect.poll(() => server.getDiagnostics().completedResponses).toBe(1);
      const diagnostics = server.getDiagnostics();
      expect(diagnostics.acceptedConnections).toBeGreaterThanOrEqual(1);
      expect(diagnostics.requestCount).toBe(1);
      expect(diagnostics.indexRequestCount).toBe(1);
      expect(diagnostics.completedResponses).toBe(1);
      expect(diagnostics.lastStatus).toBe(200);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('probes the exact index URL and reports response bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lingji-remotion-probe-test-'));
    await writeFile(path.join(root, 'index.html'), '<h1>probe-ready</h1>');
    const server = await startRemotionLocalServer(root);
    try {
      await expect(server.probe()).resolves.toEqual({
        status: 200,
        bytes: Buffer.byteLength('<h1>probe-ready</h1>'),
        contentType: 'text/html; charset=utf-8',
      });
      expect(server.getDiagnostics().indexRequestCount).toBe(1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports byte ranges required by browser media playback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lingji-remotion-range-test-'));
    await writeFile(path.join(root, 'clip.mp4'), '0123456789');
    const server = await startRemotionLocalServer(root);
    try {
      const response = await fetch(`${server.serveUrl}/clip.mp4`, {
        headers: { Range: 'bytes=2-5' },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await response.text()).toBe('2345');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
