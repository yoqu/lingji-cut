import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentStreamEvent } from '../../electron/agent-runtime/event-model';
import {
  extractFinalAssistantError,
  PiInProcessSession,
} from '../../electron/agent-runtime/pi-inprocess';

interface PiSessionHarness {
  cwd?: string;
  onEvent: (event: AgentStreamEvent) => void;
  handleEvent: (event: AgentSessionEvent) => void;
}

function createSessionHarness(cwd?: string) {
  const events: AgentStreamEvent[] = [];
  const session = new PiInProcessSession();
  const harness = session as unknown as PiSessionHarness;
  harness.cwd = cwd;
  harness.onEvent = (event) => events.push(event);
  return { harness, events };
}

function messageUpdate(
  type: 'toolcall_start' | 'toolcall_delta' | 'toolcall_end',
  input: Record<string, unknown>,
): AgentSessionEvent {
  const toolCall = {
    type: 'toolCall',
    id: 'write-1',
    name: 'write',
    arguments: input,
  };
  const assistantMessageEvent = {
    contentIndex: 0,
    delta: '',
    partial: { role: 'assistant', content: [toolCall] },
    ...(type === 'toolcall_end' ? { toolCall } : {}),
  };
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [toolCall] },
    assistantMessageEvent: { ...assistantMessageEvent, type },
  } as unknown as AgentSessionEvent;
}

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

describe('PiInProcessSession tool input streaming', () => {
  it('forwards growing write arguments before tool execution without duplicating the tool block', () => {
    const { harness, events } = createSessionHarness();

    harness.handleEvent(messageUpdate('toolcall_start', {
      path: 'notes.md',
      content: 'first',
    }));
    expect(events).toEqual([{
      type: 'tool_use',
      id: 'write-1',
      name: 'write',
      input: { path: 'notes.md', content: 'first' },
    }]);

    harness.handleEvent(messageUpdate('toolcall_delta', {
      path: 'notes.md',
      content: 'first\nsecond',
    }));
    harness.handleEvent({
      type: 'tool_execution_start',
      toolCallId: 'write-1',
      toolName: 'write',
      args: { path: 'notes.md', content: 'first\nsecond\nthird' },
    });

    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(events.slice(1)).toEqual([
      {
        type: 'tool_input_delta',
        id: 'write-1',
        delta: JSON.stringify({ path: 'notes.md', content: 'first\nsecond' }),
      },
      {
        type: 'tool_input_delta',
        id: 'write-1',
        delta: JSON.stringify({ path: 'notes.md', content: 'first\nsecond\nthird' }),
      },
    ]);
  });

  it('attaches the actual before/after text to completed file edits', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inprocess-edit-'));
    try {
      fs.writeFileSync(path.join(cwd, 'original.md'), 'old line\n', 'utf-8');
      const { harness, events } = createSessionHarness(cwd);

      harness.handleEvent({
        type: 'tool_execution_start',
        toolCallId: 'edit-1',
        toolName: 'edit',
        args: {
          path: 'original.md',
          edits: [{ oldText: 'old line', newText: 'new line' }],
        },
      });
      fs.writeFileSync(path.join(cwd, 'original.md'), 'new line\n', 'utf-8');
      harness.handleEvent({
        type: 'tool_execution_end',
        toolCallId: 'edit-1',
        toolName: 'edit',
        result: {
          content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in original.md.' }],
        },
        isError: false,
      });

      expect(events.at(-1)).toMatchObject({
        type: 'tool_result',
        toolUseId: 'edit-1',
        name: 'edit',
        input: {
          path: 'original.md',
          edits: [{ oldText: 'old line', newText: 'new line' }],
          before: 'old line\n',
          after: 'new line\n',
        },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
