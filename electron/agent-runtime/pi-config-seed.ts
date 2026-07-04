import fs from 'node:fs/promises';
import path from 'node:path';
import type { AISettings } from '../../src/types/ai';
import { buildPiAuthJson, buildPiModelsJson, buildPiSettingsJson } from './pi-provider-projection';

async function readExistingJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    // 半截 JSON（并发写入途中被读到）当作空对象，交由本次写入覆盖，不让瞬时竞态判死。
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

let tmpSeq = 0;

/** 原子写：先写同目录临时文件再 rename，避免并发读到写了一半的半截内容。 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${(tmpSeq += 1)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

// 串行化 writePiConfig：多张卡并行生成时各自会 ensure 配置，并发的 read-modify-write
// （auth.json）与非原子写会互相撕裂（Unexpected end of JSON input）。同一进程内共用此链条。
let writeChain: Promise<unknown> = Promise.resolve();

/** 把 App AISettings 投影并写入 pi 配置目录（auth.json + settings.json + models.json）。 */
export async function writePiConfig(configDir: string, ai: AISettings): Promise<void> {
  const run = writeChain.then(async () => {
    await fs.mkdir(configDir, { recursive: true });
    await writeJsonAtomic(path.join(configDir, 'models.json'), buildPiModelsJson(ai));
    await writeJsonAtomic(path.join(configDir, 'settings.json'), buildPiSettingsJson(ai));
    const authPath = path.join(configDir, 'auth.json');
    const nextAuth = { ...(await readExistingJson(authPath)), ...buildPiAuthJson(ai) };
    await writeJsonAtomic(authPath, nextAuth);
  });
  // 链条不因单次失败而断裂：无论成败都推进 writeChain；真实错误仍抛给本次调用方。
  writeChain = run.catch(() => {});
  return run;
}
