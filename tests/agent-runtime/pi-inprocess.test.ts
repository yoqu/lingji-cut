import { describe, expect, it } from 'vitest';
import { extractFinalAssistantError } from '../../electron/agent-runtime/pi-inprocess';

describe('extractFinalAssistantError', () => {
  it('extracts the final assistant error from pi agent_end messages', () => {
    expect(
      extractFinalAssistantError([
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '403 Your request was blocked.',
        },
      ]),
    ).toBe('403 Your request was blocked.');
  });

  it('returns null for successful assistant messages', () => {
    expect(
      extractFinalAssistantError([
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' },
      ]),
    ).toBeNull();
  });
});
