// tests/cli-client.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connectClient } from '../cli/src/client';

const TOKEN = 'tk-test';
const servers: Server[] = [];

/** 起一个模拟控制服务：/health + /invoke（带 token 校验） */
function startFakeServer(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/invoke' && req.method === 'POST') {
      if (req.headers['x-lingji-token'] !== TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized', code: 'unauthorized' }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { op } = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (op === 'lingji_get_active_project') {
          res.end(JSON.stringify({ ok: true, data: { projectPath: '/p' } }));
        } else {
          res.end(JSON.stringify({ ok: false, error: `未知操作: ${op}`, code: 'unknown_op' }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterAll(() => {
  for (const s of servers) s.close();
});

describe('connectClient', () => {
  it('calls /invoke and returns data on ok', async () => {
    const url = await startFakeServer();
    const client = await connectClient({ url, token: TOKEN });
    const data = await client.call('lingji_get_active_project');
    expect(data).toEqual({ projectPath: '/p' });
    await client.close();
  });

  it('throws CliError with code on ok:false', async () => {
    const url = await startFakeServer();
    const client = await connectClient({ url, token: TOKEN });
    await expect(client.call('lingji_nope')).rejects.toMatchObject({ code: 'unknown_op' });
    await client.close();
  });

  it('throws unauthorized on 401', async () => {
    const url = await startFakeServer();
    const client = await connectClient({ url, token: 'wrong' });
    await expect(client.call('lingji_get_active_project')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await client.close();
  });

  it('throws server_unreachable when nothing listens', async () => {
    await expect(connectClient({ url: 'http://127.0.0.1:1', token: TOKEN })).rejects.toMatchObject({
      code: 'server_unreachable',
    });
  });
});
