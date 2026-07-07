// cli/src/endpoint.ts
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:19820';
const DEFAULT_ENDPOINT_FILE = join(homedir(), '.lingji', 'control-endpoint.json');

export interface ControlEndpoint {
  url: string;
  token?: string;
}

export interface ResolveOptions {
  serverFlag?: string;
  tokenFlag?: string;
  env?: Record<string, string | undefined>;
  endpointFile?: string;
}

/**
 * 解析控制服务端点：
 * url:   --server > LINGJI_CONTROL_URL > 端点文件 > 默认
 * token: --token  > LINGJI_CONTROL_TOKEN > 端点文件
 */
export function resolveEndpoint(opts: ResolveOptions = {}): ControlEndpoint {
  const env = opts.env ?? process.env;
  const file = opts.endpointFile ?? DEFAULT_ENDPOINT_FILE;
  let fileInfo: { url?: string; port?: number; token?: string } | null = null;
  if (existsSync(file)) {
    try {
      fileInfo = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // 文件损坏则忽略
    }
  }

  let url = DEFAULT_URL;
  if (opts.serverFlag) url = opts.serverFlag;
  else if (env.LINGJI_CONTROL_URL) url = env.LINGJI_CONTROL_URL;
  else if (typeof fileInfo?.url === 'string') url = fileInfo.url;
  else if (typeof fileInfo?.port === 'number') url = `http://127.0.0.1:${fileInfo.port}`;

  const token =
    opts.tokenFlag ??
    env.LINGJI_CONTROL_TOKEN ??
    (typeof fileInfo?.token === 'string' ? fileInfo.token : undefined);

  return { url: normalize(url), token };
}

/** 归一化为基址：去尾斜杠与旧 /mcp、/invoke 后缀 */
function normalize(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/(mcp|invoke)$/, '');
}
