// tests/cli-cards-command.test.ts
import { describe, it, expect } from 'vitest';
import { runCardsCommand } from '../cli/src/commands/cards';
import type { ToolCaller } from '../cli/src/client';
function fake() { const calls: any[] = []; return { calls, client: { async call(n: string, a?: unknown) { calls.push({ name: n, args: a }); return n === 'lingji_get_active_project' ? { projectPath: '/p' } : (n === 'lingji_list_cards' ? [{ id: 'c1' }] : { taskId: 't' }); }, async close() {} } as ToolCaller }; }

describe('runCardsCommand', () => {
  it('gen 已移除 → bad_args（生成卡片走 subtitle analyze）', async () => { const { client } = fake(); await expect(runCardsCommand('gen', [], {}, client)).rejects.toMatchObject({ code: 'bad_args' }); });
  it('list → lingji_list_cards (instant)', async () => { const { client, calls } = fake(); const r = await runCardsCommand('list', [], {}, client); expect(calls.some((c) => c.name === 'lingji_list_cards')).toBe(true); expect((r as any[])[0].id).toBe('c1'); });
  it('show <id> → lingji_get_card', async () => { const { client, calls } = fake(); await runCardsCommand('show', ['c1'], {}, client); expect(calls.find((c) => c.name === 'lingji_get_card')?.args).toMatchObject({ projectPath: '/p', cardId: 'c1' }); });
  it('update <id> --enabled false → lingji_update_card', async () => { const { client, calls } = fake(); await runCardsCommand('update', ['c1'], { enabled: 'false' }, client); const call = calls.find((c) => c.name === 'lingji_update_card'); expect(call.args).toMatchObject({ projectPath: '/p', cardId: 'c1', enabled: false }); });
  it('delete <id> → lingji_delete_card', async () => { const { client, calls } = fake(); await runCardsCommand('delete', ['c1'], {}, client); expect(calls.find((c) => c.name === 'lingji_delete_card')?.args).toMatchObject({ cardId: 'c1' }); });
  it('regenerate <id> → lingji_regenerate_card (task)', async () => { const { client, calls } = fake(); await runCardsCommand('regenerate', ['c1'], {}, client); const call = calls.find((c) => c.name === 'lingji_regenerate_card'); expect(call.args).toMatchObject({ projectPath: '/p', cardId: 'c1' }); });
  it('convert <id> --to motion → lingji_convert_card', async () => { const { client, calls } = fake(); await runCardsCommand('convert', ['c1'], { to: 'motion' }, client); const call = calls.find((c) => c.name === 'lingji_convert_card'); expect(call.args).toMatchObject({ projectPath: '/p', cardId: 'c1', to: 'motion' }); });
  it('unknown → bad_args', async () => { const { client } = fake(); await expect(runCardsCommand('frob', [], {}, client)).rejects.toMatchObject({ code: 'bad_args' }); });
});
