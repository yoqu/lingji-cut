import fs from 'node:fs';
import path from 'node:path';
import type { AgentStreamEvent } from './event-model';

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const TOOL_CALL_EVENT_TYPES = new Set([
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
]);
const FILE_PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'targetPath', 'file'];

export interface PiToolCallUpdate {
  id: string;
  name: string;
  input: unknown;
}

interface TrackedToolCall {
  name: string;
  input: unknown;
  lastSerializedInput?: string;
}

interface FileSnapshot {
  absolutePath: string;
  displayPath: string;
  before: string | null;
  existed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? JSON.stringify(String(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

function toolCallFromEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(event.toolCall);
  if (direct) return direct;

  const partial = asRecord(event.partial);
  const content = partial?.content;
  if (!Array.isArray(content)) return null;
  const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0;
  return asRecord(content[index]);
}

export function extractPiToolCallUpdate(event: unknown): PiToolCallUpdate | null {
  const record = asRecord(event);
  if (!record || !TOOL_CALL_EVENT_TYPES.has(String(record.type ?? ''))) return null;
  const toolCall = toolCallFromEvent(record);
  if (!toolCall || toolCall.type !== 'toolCall') return null;

  const id = typeof toolCall.id === 'string' ? toolCall.id : '';
  const name = typeof toolCall.name === 'string' ? toolCall.name : '';
  if (!id || !name) return null;
  return { id, name, input: toolCall.arguments ?? null };
}

function pickPath(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  for (const key of FILE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function isFileMutationTool(name: string): boolean {
  return /(edit|write|create|overwrite|patch|apply|replace|delete|remove|unlink)/i.test(name);
}

function resolveProjectFile(cwd: string, rawPath: string): string | null {
  if (rawPath.startsWith('file://')) return null;
  const projectRoot = path.resolve(cwd);
  const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return absolutePath;
}

function readTextSnapshot(filePath: string): { existed: boolean; content: string | null } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('\0')) return null;
    return { existed: true, content };
  } catch (error) {
    const code = asRecord(error)?.code;
    return code === 'ENOENT' ? { existed: false, content: null } : null;
  }
}

class PiFileSnapshotTracker {
  private readonly snapshots = new Map<string, FileSnapshot>();

  constructor(private readonly cwd?: string) {}

  remember(call: PiToolCallUpdate): void {
    if (!this.cwd || this.snapshots.has(call.id) || !isFileMutationTool(call.name)) return;
    const rawPath = pickPath(call.input);
    if (!rawPath) return;
    const absolutePath = resolveProjectFile(this.cwd, rawPath);
    if (!absolutePath) return;
    const snapshot = readTextSnapshot(absolutePath);
    if (!snapshot) return;
    this.snapshots.set(call.id, {
      absolutePath,
      displayPath: path.relative(this.cwd, absolutePath) || rawPath,
      before: snapshot.content,
      existed: snapshot.existed,
    });
  }

  enrichResult(toolCallId: string, input: unknown, isError: boolean): unknown {
    const snapshot = this.snapshots.get(toolCallId);
    this.snapshots.delete(toolCallId);
    if (isError || !snapshot?.existed || snapshot.before === null) return input;
    const current = readTextSnapshot(snapshot.absolutePath);
    if (!current) return input;
    const after = current.existed ? current.content ?? '' : '';
    if (after === snapshot.before) return input;
    const record = asRecord(input);
    if (!record) return input;
    return {
      ...record,
      path: pickPath(record) ?? snapshot.displayPath,
      before: snapshot.before,
      after,
    };
  }

  clear(): void {
    this.snapshots.clear();
  }
}

/** Bridges Pi's growing tool arguments into the renderer's replace-style rawInput updates. */
export class PiToolEventRelay {
  private readonly calls = new Map<string, TrackedToolCall>();
  private readonly emittedIds = new Set<string>();
  private readonly snapshots: PiFileSnapshotTracker;

  constructor(
    cwd: string | undefined,
    private readonly onEvent: (event: AgentStreamEvent) => void,
  ) {
    this.snapshots = new PiFileSnapshotTracker(cwd);
  }

  observe(
    call: PiToolCallUpdate,
    options: { captureSnapshot?: boolean } = {},
  ): void {
    if (!call.id || !call.name) return;
    const current = this.calls.get(call.id);
    const input = call.input ?? current?.input ?? null;
    const name = call.name || current?.name || '';
    const serialized = safeJsonStringify(input);
    const tracked = { name, input, lastSerializedInput: serialized };
    this.calls.set(call.id, tracked);
    if (options.captureSnapshot) {
      this.snapshots.remember({ ...call, name, input });
    }

    if (!this.emittedIds.has(call.id)) {
      this.emittedIds.add(call.id);
      this.onEvent({ type: 'tool_use', id: call.id, name, input });
      return;
    }
    if (serialized === current?.lastSerializedInput) return;
    this.onEvent({ type: 'tool_input_delta', id: call.id, delta: serialized });
  }

  getInput(toolCallId: string): unknown {
    return this.calls.get(toolCallId)?.input;
  }

  complete(input: {
    toolCallId: string;
    toolName: string;
    content: string;
    isError: boolean;
  }): void {
    const tracked = this.calls.get(input.toolCallId);
    const toolInput = this.snapshots.enrichResult(
      input.toolCallId,
      tracked?.input,
      input.isError,
    );
    this.onEvent({
      type: 'tool_result',
      toolUseId: input.toolCallId,
      name: input.toolName || tracked?.name,
      input: toolInput,
      content: input.content,
      isError: input.isError,
    });
    this.calls.delete(input.toolCallId);
    this.emittedIds.delete(input.toolCallId);
  }

  clear(): void {
    this.calls.clear();
    this.emittedIds.clear();
    this.snapshots.clear();
  }
}
