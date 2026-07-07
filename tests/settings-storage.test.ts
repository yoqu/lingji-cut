import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('settings-storage global settings bridge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reads sync settings from the initial global settings snapshot', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        getInitialGlobalSettings: () =>
          JSON.stringify({
            customRoles: [
              {
                id: 'role-1',
                name: '自定义角色',
                description: '说明',
                rolePrompt: 'prompt',
              },
            ],
            selectedRole: 'deep-insight-podcast',
          }),
      },
    });

    const settingsStorage = await import('../src/lib/settings-storage');

    expect(settingsStorage.loadCustomRoles()).toHaveLength(1);
    expect(settingsStorage.loadSelectedRole()).toBe('deep-insight-podcast');
  });

  it('hydrates from the async global settings file', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        getInitialGlobalSettings: () => null,
        loadGlobalSettings: vi.fn().mockResolvedValue(
          JSON.stringify({ selectedRole: 'news-broadcast' }),
        ),
        saveGlobalSettings: vi.fn().mockResolvedValue(undefined),
      },
    });

    const settingsStorage = await import('../src/lib/settings-storage');
    await settingsStorage.hydrateSettingsStorage();

    expect(settingsStorage.loadSelectedRole()).toBe('news-broadcast');
  });
});
