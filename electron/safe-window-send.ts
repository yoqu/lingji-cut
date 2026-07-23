interface SendableWebContents {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface SendableWindow {
  isDestroyed(): boolean;
  webContents: SendableWebContents;
}

function isDestroyedSendError(error: unknown): boolean {
  return error instanceof Error && /object has been destroyed/i.test(error.message);
}

export function sendToLiveWindow(
  window: SendableWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;

  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch (error) {
    if (
      window.isDestroyed()
      || window.webContents.isDestroyed()
      || isDestroyedSendError(error)
    ) {
      return false;
    }
    throw error;
  }
}
