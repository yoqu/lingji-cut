import { writeFile, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const LINGJI_DIR = join(homedir(), '.lingji');
export const ENDPOINT_FILE = join(LINGJI_DIR, 'control-endpoint.json');
/** 旧 MCP 端点发现文件：写入/清理时一并删除，避免旧 CLI 读到失效端点 */
const LEGACY_ENDPOINT_FILE = join(LINGJI_DIR, 'mcp-endpoint.json');

export interface ControlEndpointInfo {
  url: string;
  port: number;
  pid: number;
  startedAt: number;
  /** 控制服务鉴权 token：每次启动随机生成，CLI 从此文件发现。 */
  token: string;
  /** 声呐桥共享 token：扩展从设置页复制（仅 loopback 暴露）。 */
  sonarToken?: string;
}

/** 应用启动控制服务后写入端点发现文件 */
export async function writeEndpointFile(
  info: { port: number; token: string; sonarToken?: string },
  file: string = ENDPOINT_FILE,
): Promise<void> {
  const payload: ControlEndpointInfo = {
    url: `http://127.0.0.1:${info.port}`,
    port: info.port,
    pid: process.pid,
    startedAt: Date.now(),
    token: info.token,
    ...(info.sonarToken ? { sonarToken: info.sonarToken } : {}),
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  if (file === ENDPOINT_FILE) {
    await rm(LEGACY_ENDPOINT_FILE, { force: true }).catch(() => {});
  }
}

/** 服务停止时删除端点文件（文件不存在时静默） */
export async function removeEndpointFile(
  file: string = ENDPOINT_FILE,
): Promise<void> {
  await rm(file, { force: true });
}
