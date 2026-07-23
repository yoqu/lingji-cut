import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface RemotionLocalServerDiagnostics {
  acceptedConnections: number;
  closedConnections: number;
  socketErrors: number;
  requestCount: number;
  indexRequestCount: number;
  completedResponses: number;
  abortedResponses: number;
  lastStatus: number | null;
  lastError: string | null;
}

function parseRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

export async function startRemotionLocalServer(rootDir: string): Promise<{
  serveUrl: string;
  getDiagnostics: () => RemotionLocalServerDiagnostics;
  probe: () => Promise<{ status: number; bytes: number; contentType: string | null }>;
  close: () => Promise<void>;
}> {
  const root = path.resolve(rootDir);
  const diagnostics: RemotionLocalServerDiagnostics = {
    acceptedConnections: 0,
    closedConnections: 0,
    socketErrors: 0,
    requestCount: 0,
    indexRequestCount: 0,
    completedResponses: 0,
    abortedResponses: 0,
    lastStatus: null,
    lastError: null,
  };
  const server = http.createServer(async (request, response) => {
    diagnostics.requestCount += 1;
    let responseFinished = false;
    response.once('finish', () => {
      responseFinished = true;
      diagnostics.completedResponses += 1;
    });
    response.once('close', () => {
      if (!responseFinished) diagnostics.abortedResponses += 1;
    });
    const writeStatus = (status: number, headers?: http.OutgoingHttpHeaders) => {
      diagnostics.lastStatus = status;
      response.writeHead(status, headers);
    };
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      );
      if (pathname === '/' || pathname === '/index.html') {
        diagnostics.indexRequestCount += 1;
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(root, relative);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        writeStatus(403);
        response.end('Forbidden');
        return;
      }

      const file = await stat(filePath);
      if (!file.isFile()) {
        writeStatus(404);
        response.end('Not found');
        return;
      }

      const range = parseRange(request.headers.range, file.size);
      const headers: http.OutgoingHttpHeaders = {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      };
      if (range) {
        headers['Content-Length'] = range.end - range.start + 1;
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
        writeStatus(206, headers);
        createReadStream(filePath, range).pipe(response);
        return;
      }

      headers['Content-Length'] = file.size;
      writeStatus(200, headers);
      createReadStream(filePath).pipe(response);
    } catch (error) {
      diagnostics.lastError = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) writeStatus(404);
      response.end('Not found');
    }
  });
  server.on('connection', (socket) => {
    diagnostics.acceptedConnections += 1;
    socket.once('close', () => {
      diagnostics.closedConnections += 1;
    });
    socket.once('error', (error) => {
      diagnostics.socketErrors += 1;
      diagnostics.lastError = error.message;
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Remotion 本地服务未获得有效端口');
  }
  const serveUrl = `http://127.0.0.1:${address.port}`;

  return {
    serveUrl,
    getDiagnostics: () => ({ ...diagnostics }),
    probe: () =>
      new Promise((resolve, reject) => {
        const request = http.get(`${serveUrl}/index.html`, { agent: false }, (response) => {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
          });
          response.once('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              bytes,
              contentType: response.headers['content-type'] ?? null,
            });
          });
        });
        request.setTimeout(5_000, () => {
          request.destroy(new Error('Remotion local-server probe timed out after 5000ms'));
        });
        request.once('error', reject);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
