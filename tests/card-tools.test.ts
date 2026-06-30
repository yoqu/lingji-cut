import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerCardTools } from '../electron/pipeline/card-tools';

class FakeMcpServer {
  tools = new Map<string, { def: unknown; handler: (args: unknown) => unknown }>();
  registerTool(name: string, def: unknown, handler: (args: unknown) => unknown): void {
    this.tools.set(name, { def, handler });
  }
}
function project(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-ct-'));
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    version: 1, createdAt: 'x', updatedAt: 'x', timeline: null,
    aiAnalysis: { analysisResult: { segments: [], cards: [{ id: 'c1', segmentId: 's1', type: 'summary', title: 'T', content: 'x', startMs: 0, endMs: 1000, displayDurationMs: 1000, displayMode: 'pip', template: 'default', enabled: true, style: {} }], coverPrompts: [], summary: '', keywords: [] }, coverCandidates: [] },
    script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
  }));
  return dir;
}

describe('registerCardTools', () => {
  it('registers list/get/update/delete and list returns cards', async () => {
    const dir = project();
    try {
      const server = new FakeMcpServer();
      registerCardTools(server as never, () => null, () => '/tmp');
      for (const n of [
        'lingji_list_cards',
        'lingji_get_card',
        'lingji_update_card',
        'lingji_delete_card',
        'lingji_get_card_context',
        'lingji_validate_card',
      ]) {
        expect(server.tools.has(n)).toBe(true);
      }
      const res = (await server.tools.get('lingji_list_cards')!.handler({ projectPath: dir })) as { content: { text: string }[] };
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed[0].id).toBe('c1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('update_card applies whitelisted field', async () => {
    const dir = project();
    try {
      const server = new FakeMcpServer();
      registerCardTools(server as never, () => null, () => '/tmp');
      const res = (await server.tools.get('lingji_update_card')!.handler({ projectPath: dir, cardId: 'c1', enabled: false })) as { content: { text: string }[] };
      expect(JSON.parse(res.content[0].text).enabled).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
