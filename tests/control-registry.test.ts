import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ControlRegistry } from '../electron/control/registry';

function textEnvelope(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

describe('ControlRegistry', () => {
  it('dispatches op to handler and unwraps envelope', async () => {
    const reg = new ControlRegistry();
    reg.registerTool('lingji_ping', { title: 'ping', description: '' }, async () =>
      textEnvelope({ pong: true }),
    );
    expect(await reg.invoke('lingji_ping', {})).toEqual({ ok: true, data: { pong: true } });
  });

  it('validates args against inputSchema', async () => {
    const reg = new ControlRegistry();
    reg.registerTool(
      'lingji_echo',
      { title: 'echo', description: '', inputSchema: { msg: z.string() } },
      async ({ msg }) => textEnvelope({ msg }),
    );
    expect(await reg.invoke('lingji_echo', { msg: 'hi' })).toEqual({ ok: true, data: { msg: 'hi' } });
    const bad = await reg.invoke('lingji_echo', { msg: 42 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('invalid_args');
  });

  it('translates isError envelope to ok:false with code', async () => {
    const reg = new ControlRegistry();
    reg.registerTool('lingji_fail', { title: 'fail', description: '' }, async () =>
      textEnvelope({ error: '无效项目', code: 'invalid_project' }, true),
    );
    expect(await reg.invoke('lingji_fail', {})).toEqual({
      ok: false,
      error: '无效项目',
      code: 'invalid_project',
    });
  });

  it('catches thrown errors with code passthrough', async () => {
    const reg = new ControlRegistry();
    reg.registerTool('lingji_boom', { title: 'boom', description: '' }, async () => {
      const err = new Error('炸了') as Error & { code: string };
      err.code = 'boom_code';
      throw err;
    });
    expect(await reg.invoke('lingji_boom', {})).toEqual({ ok: false, error: '炸了', code: 'boom_code' });
  });

  it('returns unknown_op for unregistered op and rejects duplicate registration', async () => {
    const reg = new ControlRegistry();
    expect((await reg.invoke('lingji_nope', {})).code).toBe('unknown_op');
    reg.registerTool('lingji_a', { title: 'a', description: '' }, async () => textEnvelope(null));
    expect(() =>
      reg.registerTool('lingji_a', { title: 'a', description: '' }, async () => textEnvelope(null)),
    ).toThrow();
  });

  it('listOps returns sorted names', () => {
    const reg = new ControlRegistry();
    reg.registerTool('lingji_b', { title: 'b', description: '' }, async () => textEnvelope(null));
    reg.registerTool('lingji_a', { title: 'a', description: '' }, async () => textEnvelope(null));
    expect(reg.listOps()).toEqual(['lingji_a', 'lingji_b']);
  });
});
