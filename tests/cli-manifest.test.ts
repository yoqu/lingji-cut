// tests/cli-manifest.test.ts
// 防漂移契约测试：CLI 命令 manifest ↔ 控制服务注册工具 ↔ 命令实现三方一致。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { COMMANDS, manifestOps, buildHelp } from '../cli/src/manifest';
import { ControlRegistry } from '../electron/control/registry';
import { registerPipelineMcpTools } from '../electron/pipeline/tools/register';

/** 服务端有意不暴露给 CLI 的操作（写稿走 file-first；阻塞式导入被非阻塞变体取代） */
const INTENTIONALLY_UNEXPOSED = new Set([
  'lingji_write_script',
  'lingji_update_script',
  'lingji_import_video_source',
]);

const repo = (p: string) => new URL(`../${p}`, import.meta.url);

function serverOps(): Set<string> {
  const reg = new ControlRegistry();
  registerPipelineMcpTools(reg, () => null, () => '/tmp/fake-user-data');
  const ops = new Set(reg.listOps());
  // control/tools.ts 与 publish/tools.ts 顶层 import electron，无法在 vitest 中实例化 → 源码扫描
  for (const file of ['electron/control/tools.ts', 'electron/publish/tools.ts']) {
    const src = readFileSync(repo(file), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*\n?\s*'(lingji_[a-z_]+)'/g)) ops.add(m[1]);
  }
  return ops;
}

function cliUsedOps(): Set<string> {
  const dirs = ['cli/src/commands', 'cli/src'];
  const ops = new Set<string>();
  for (const dir of dirs) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!f.endsWith('.ts') || f === 'manifest.ts') continue;
      const full = path.join(dir, f);
      const src = readFileSync(repo(full), 'utf8');
      for (const m of src.matchAll(/'(lingji_[a-z_]+)'/g)) ops.add(m[1]);
    }
  }
  return ops;
}

describe('CLI manifest 一致性', () => {
  it('manifest 中每个 op 都在控制服务注册', () => {
    const server = serverOps();
    const missing = [...manifestOps()].filter((op) => !server.has(op));
    expect(missing).toEqual([]);
  });

  it('命令实现使用的每个 op 都在 manifest 中声明', () => {
    const declared = manifestOps();
    const undeclared = [...cliUsedOps()].filter((op) => !declared.has(op));
    expect(undeclared).toEqual([]);
  });

  it('服务端未进 manifest 的 op 必须在有意不暴露清单里', () => {
    const declared = manifestOps();
    const stray = [...serverOps()].filter(
      (op) => !declared.has(op) && !INTENTIONALLY_UNEXPOSED.has(op),
    );
    expect(stray).toEqual([]);
  });

  it('有意不暴露清单不与 manifest 重叠且仍存在于服务端', () => {
    const declared = manifestOps();
    const server = serverOps();
    for (const op of INTENTIONALLY_UNEXPOSED) {
      expect(declared.has(op)).toBe(false);
      expect(server.has(op)).toBe(true);
    }
  });

  it('help 文本覆盖全部命令 usage', () => {
    const help = buildHelp();
    for (const c of COMMANDS) {
      expect(help).toContain(c.usage.split(' [')[0]);
    }
  });
});
