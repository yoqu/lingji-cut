import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendToLiveWindow } from '../electron/safe-window-send';

describe('safe window IPC send', () => {
  it('has a dedicated helper for progress events that can outlive the renderer window', () => {
    const helperPath = fileURLToPath(
      new URL('../electron/safe-window-send.ts', import.meta.url),
    );

    expect(existsSync(helperPath)).toBe(true);
  });

  it('exports a helper for guarded BrowserWindow sends', async () => {
    const helper = await import('../electron/safe-window-send');

    expect(typeof helper.sendToLiveWindow).toBe('function');
  });

  it('sends progress to a live window', () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    };

    expect(sendToLiveWindow(window, 'render-progress', 0.25)).toBe(true);
    expect(send).toHaveBeenCalledWith('render-progress', 0.25);
  });

  it('skips a window that has already been destroyed', () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send },
    };

    expect(sendToLiveWindow(window, 'render-progress', 0.25)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows the close-race error when webContents is destroyed during send', () => {
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new TypeError('Object has been destroyed');
        },
      },
    };

    expect(() => sendToLiveWindow(window, 'render-progress', 0.25)).not.toThrow();
    expect(sendToLiveWindow(window, 'render-progress', 0.25)).toBe(false);
  });

  it('does not hide unrelated IPC send failures', () => {
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new Error('unexpected transport failure');
        },
      },
    };

    expect(() => sendToLiveWindow(window, 'render-progress', 0.25))
      .toThrow('unexpected transport failure');
  });
});
