import { describe, it, expect } from 'vitest';
import { registerPipelineMcpTools } from '../electron/pipeline/tools/register';

class FakeMcpServer {
  tools = new Map<string, { def: unknown; handler: (args: unknown) => unknown }>();
  registerTool(name: string, def: unknown, handler: (args: unknown) => unknown): void {
    this.tools.set(name, { def, handler });
  }
}

describe('registerPipelineMcpTools', () => {
  it('registers the 7 pipeline tools by name', () => {
    const server = new FakeMcpServer();
    registerPipelineMcpTools(
      server as unknown as Parameters<typeof registerPipelineMcpTools>[0],
      () => null,
      () => '/tmp/fake-user-data',
    );
    const expected = [
      'lingji_create_project',
      'lingji_open_project',
      'lingji_get_project_state',
      'lingji_get_settings',
      'lingji_get_task_status',
      'lingji_cancel_task',
      'lingji_list_tasks',
      'lingji_get_active_project',
      'lingji_list_recent_projects',
      'lingji_generate_audio',
      'lingji_analyze_subtitles',
      'lingji_generate_cover_prompts',
      'lingji_generate_cover_images',
      'lingji_generate_covers',
      'lingji_generate_publish_metadata',
      'lingji_export_video',
      'lingji_list_cards',
      'lingji_get_card',
      'lingji_update_card',
      'lingji_delete_card',
      'lingji_regenerate_card',
      'lingji_regenerate_card_media',
      'lingji_convert_card',
    ];
    for (const name of expected) {
      expect(server.tools.has(name)).toBe(true);
    }
    expect(server.tools.size).toBeGreaterThanOrEqual(22);
  });

  it('lingji_create_project handler returns success result for fresh dir', async () => {
    const server = new FakeMcpServer();
    registerPipelineMcpTools(
      server as unknown as Parameters<typeof registerPipelineMcpTools>[0],
      () => null,
      () => '/tmp/fake-user-data',
    );
    const handler = server.tools.get('lingji_create_project')!.handler;
    const { mkdtempSync, rmSync } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lingji-mcp-reg-'));
    try {
      const target = path.join(root, 'p');
      const result = (await handler({ path: target })) as { content: { text: string }[] };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.projectPath).toBe(target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lingji_open_project switches the live window to the validated project', async () => {
    const server = new FakeMcpServer();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
    registerPipelineMcpTools(
      server as unknown as Parameters<typeof registerPipelineMcpTools>[0],
      () => fakeWin as unknown as import('electron').BrowserWindow,
      () => '/tmp/fake-user-data',
    );
    const createHandler = server.tools.get('lingji_create_project')!.handler;
    const openHandler = server.tools.get('lingji_open_project')!.handler;
    const { mkdtempSync, rmSync } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lingji-open-'));
    try {
      const target = path.join(root, 'p');
      await createHandler({ path: target });
      const result = (await openHandler({ path: target })) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
      expect(sent).toContainEqual({
        channel: 'menu-action',
        payload: { type: 'open-recent-project', projectDir: target },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lingji_open_project does not send a window event for an invalid project', async () => {
    const server = new FakeMcpServer();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
    registerPipelineMcpTools(
      server as unknown as Parameters<typeof registerPipelineMcpTools>[0],
      () => fakeWin as unknown as import('electron').BrowserWindow,
      () => '/tmp/fake-user-data',
    );
    const openHandler = server.tools.get('lingji_open_project')!.handler;
    const path = await import('node:path');
    const os = await import('node:os');
    const result = (await openHandler({ path: path.join(os.tmpdir(), 'lingji-missing-xyz') })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('returns structured error with code when create_project rejects', async () => {
    const server = new FakeMcpServer();
    registerPipelineMcpTools(
      server as unknown as Parameters<typeof registerPipelineMcpTools>[0],
      () => null,
      () => '/tmp/fake-user-data',
    );
    const handler = server.tools.get('lingji_create_project')!.handler;
    const result = (await handler({ path: 'relative/path' })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('invalid_project');
    expect(typeof parsed.error).toBe('string');
  });
});
