import { describe, expect, it } from 'vitest';
import { evaluateHeadlessToolGate } from '../electron/agent-runtime/pi-headless';

const CWD = '/tmp/work';

describe('evaluateHeadlessToolGate（无头角色工具守卫）', () => {
  it('bash 类工具一律拦截', () => {
    for (const name of ['bash', 'shell', 'exec', 'run_command', 'terminal']) {
      const decision = evaluateHeadlessToolGate(name, { command: 'ls' }, { cwd: CWD, writeWithinDir: CWD });
      expect(decision?.block).toBe(true);
    }
  });

  it('read 等非写入工具放行', () => {
    expect(evaluateHeadlessToolGate('read', { path: '/etc/hosts' }, { cwd: CWD })).toBeUndefined();
  });

  it('write/edit 在未开放写入目录的角色上拦截', () => {
    expect(evaluateHeadlessToolGate('write', { path: 'motionCard.tsx' }, { cwd: CWD })?.block).toBe(true);
  });

  it('write/edit 目标落在 writeWithinDir 内放行（相对与绝对路径）', () => {
    const opts = { cwd: CWD, writeWithinDir: CWD };
    expect(evaluateHeadlessToolGate('write', { path: 'motionCard.tsx' }, opts)).toBeUndefined();
    expect(evaluateHeadlessToolGate('edit', { path: `${CWD}/motionCard.tsx` }, opts)).toBeUndefined();
    expect(evaluateHeadlessToolGate('write', { file_path: `${CWD}/sub/a.tsx` }, opts)).toBeUndefined();
  });

  it('write/edit 目标越界拦截（含 .. 逃逸与前缀伪装）', () => {
    const opts = { cwd: CWD, writeWithinDir: CWD };
    expect(evaluateHeadlessToolGate('write', { path: '../outside.tsx' }, opts)?.block).toBe(true);
    expect(evaluateHeadlessToolGate('write', { path: '/tmp/work2/evil.tsx' }, opts)?.block).toBe(true);
    expect(evaluateHeadlessToolGate('edit', { path: '/etc/passwd' }, opts)?.block).toBe(true);
  });

  it('写入目标缺失时拦截', () => {
    expect(
      evaluateHeadlessToolGate('write', {}, { cwd: CWD, writeWithinDir: CWD })?.block,
    ).toBe(true);
  });
});
