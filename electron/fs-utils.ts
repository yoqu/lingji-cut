import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

/** 读文本文件；不存在返回 null，其余错误照抛。 */
export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** readTextIfExists 的同步版，仅供启动期同步 IPC 使用。 */
export function readTextIfExistsSync(filePath: string): string | null {
  try {
    return fsSync.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
