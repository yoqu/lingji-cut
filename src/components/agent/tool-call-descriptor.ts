import { structuredPatch } from 'diff';

export interface ToolCallBlockLike {
  type: 'tool_call';
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: string;
  rawOutput?: string;
}

export type ToolDetailKind = 'text' | 'code' | 'diff' | 'json' | 'shell';

export interface ToolDetailSection {
  label: string;
  content: string;
  kind: ToolDetailKind;
}

export interface ToolCallDescriptor {
  label: string;
  subject: string;
  previewLabel: string;
  meta: string[];
  toolName: string;
  category: 'command' | 'read' | 'edit' | 'write' | 'delete' | 'search' | 'unknown';
  sections: ToolDetailSection[];
}

export interface FileChangeDescriptor {
  path: string;
  before: string | null;
  after: string;
  diff?: string;
  operation: 'edit' | 'create' | 'delete';
}

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shellCommand', 'shell_command', 'cmdline'];
const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filepath',
  'uri',
  'target',
  'targetPath',
  'target_path',
  'file',
  'fileName',
  'filename',
  'name',
];
const CONTENT_KEYS = ['content', 'text', 'data', 'body', 'contents'];
const OLD_TEXT_KEYS = [
  'oldString',
  'old_string',
  'oldText',
  'old_text',
  'before',
  'original',
  'old',
  'search',
  'find',
];
const NEW_TEXT_KEYS = [
  'newString',
  'new_string',
  'newText',
  'new_text',
  'after',
  'replacement',
  'replace',
  'new',
];
const NESTED_CONTAINER_KEYS = [
  'input',
  'args',
  'arguments',
  'params',
  'data',
  'payload',
  'toolInput',
  'file',
  'target',
  'options',
];

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJsonObject(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    return parseJsonObject(value);
  }
  return null;
}

function nestedRecord(record: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null {
  if (!record) return null;
  for (const key of keys) {
    const nested = recordValue(record[key]);
    if (nested) return nested;
  }
  return null;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickNestedString(record: Record<string, unknown> | null, keys: string[]): string {
  const direct = pickString(record, keys);
  if (direct) return direct;
  const nested = nestedRecord(record, ['input', 'args', 'arguments', 'params', 'data']);
  return pickString(nested, keys);
}

function pickNestedNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  const direct = pickNumber(record, keys);
  if (direct !== undefined) return direct;
  const nested = nestedRecord(record, ['input', 'args', 'arguments', 'params', 'data']);
  return pickNumber(nested, keys);
}

function pickNestedStringDeep(record: Record<string, unknown> | null, keys: string[]): string {
  const direct = pickNestedString(record, keys);
  if (direct) return direct;
  if (!record) return '';

  for (const containerKey of NESTED_CONTAINER_KEYS) {
    const nested = recordValue(record[containerKey]);
    const nestedValue = pickNestedString(nested, keys);
    if (nestedValue) return nestedValue;
  }

  for (const value of Object.values(record)) {
    const nested = recordValue(value);
    const nestedValue = pickNestedString(nested, keys);
    if (nestedValue) return nestedValue;
  }

  return '';
}

function normalizeToolName(block: ToolCallBlockLike): string {
  return textValue(block.title).trim().toLowerCase();
}

function lineRange(args: Record<string, unknown> | null): string {
  const offset = pickNumber(args, ['offset', 'startLine', 'line']);
  const limit = pickNumber(args, ['limit']);
  if (offset === undefined && limit === undefined) return '';
  const start = offset ?? 1;
  if (limit === undefined) return `:${start}`;
  return `:${start}-${Math.max(start, start + limit - 1)}`;
}

function countContentLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

function diffStats(diff: string): string | null {
  if (!diff) return null;
  let additions = 0;
  let removals = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) removals += 1;
  }
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (removals > 0) parts.push(`-${removals}`);
  return parts.length > 0 ? parts.join(' / ') : null;
}

interface ReplacementEdit {
  oldText: string;
  newText: string;
}

function normalizeDiffBoundary(text: string): string {
  return text && !text.endsWith('\n') ? `${text}\n` : text;
}

/**
 * 从工具入参里抽取 pi 风格的 edits 数组：`{ path, edits:[{oldText,newText}] }`。
 *
 * pi 的 edit 工具把多次替换嵌在 edits[] 里（而非顶层扁平 oldText/newText），且部分
 * 模型（Opus / GLM 等）会把 edits 整体当 JSON 字符串发。这里兼容数组与 JSON 字符串，
 * 并复用 OLD/NEW_TEXT_KEYS 容忍字段别名。无可识别 edits 时返回空数组。
 */
function extractEdits(record: Record<string, unknown> | null): ReplacementEdit[] {
  if (!record) return [];
  let raw: unknown =
    record.edits ?? nestedRecord(record, NESTED_CONTAINER_KEYS)?.edits ?? undefined;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const edits: ReplacementEdit[] = [];
  for (const entry of raw) {
    const editRecord = recordValue(entry);
    if (!editRecord) continue;
    const oldText = pickString(editRecord, OLD_TEXT_KEYS);
    const newText = pickString(editRecord, NEW_TEXT_KEYS);
    if (oldText || newText) edits.push({ oldText, newText });
  }
  return edits;
}

/** 把一组 {oldText,newText} 替换合成单文件头、逐条 hunk 的 unified diff。 */
function makeEditsDiff(path: string, edits: ReplacementEdit[]): string {
  // 用 jsdiff 的 structuredPatch 走真正的行级 LCS：
  //   - "开头加一行" 这类只改首行的场景，only 输出 "+新行" 一行的 hunk + 上下文，
  //     而不是把整段 before 标记 - / 整段 after 标记 +。
  //   - oldString/newString 同时为多行时只输出真实差异行，不再放大成整段替换。
  //   - 多条 edits 时共用一个文件头，逐条追加 hunk（行号相对各自片段，与单条一致）。
  const body: string[] = [];
  for (const { oldText, newText } of edits) {
    // structuredPatch 对最后一行无换行的内容会写出 `\ No newline at end of file` 元行；
    // 我们在序列化时统一吃掉，但 patch 算法本身仍按真实内容跑。
    const patch = structuredPatch(
      path,
      path,
      normalizeDiffBoundary(oldText ?? ''),
      normalizeDiffBoundary(newText ?? ''),
      '',
      '',
      { context: 3 },
    );
    for (const hunk of patch.hunks) {
      body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const raw of hunk.lines) {
        // 跳过 `\ No newline at end of file` 之类的元信息行，避免渲染层把它当 diff 行展示。
        if (raw.startsWith('\\')) continue;
        body.push(raw);
      }
    }
  }
  if (!body.length) return '';
  return [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n');
}

function makeReplacementDiff(path: string, before: string, after: string): string {
  return makeEditsDiff(path, [{ oldText: before ?? '', newText: after ?? '' }]);
}

function shellContent(command: string, rawOutput?: string): string {
  const output = textValue(rawOutput).trimEnd();
  return `$ ${command}${output.trim() ? `\n${output}` : '\n(no output)'}`;
}

function outputSection(rawOutput?: string, label = 'Output', kind: ToolDetailKind = 'code'): ToolDetailSection[] {
  const output = textValue(rawOutput);
  return output ? [{ label, content: output, kind }] : [];
}

function rawJsonSection(rawInput?: string): ToolDetailSection[] {
  const input = textValue(rawInput);
  return input ? [{ label: 'Input', content: input, kind: 'json' }] : [];
}

function targetSection(target: string): ToolDetailSection[] {
  return target ? [{ label: 'Target', content: target, kind: 'text' }] : [];
}

export function describeToolCallBlock(block: ToolCallBlockLike): ToolCallDescriptor {
  const args = parseJsonObject(block.rawInput);
  const toolName = normalizeToolName(block);
  const kind = textValue(block.kind).toLowerCase();
  const output = textValue(block.rawOutput);
  const hasInput = Boolean(textValue(block.rawInput));
  const command = pickNestedStringDeep(args, COMMAND_KEYS);
  const path = pickNestedStringDeep(args, PATH_KEYS);
  const content = pickNestedStringDeep(args, CONTENT_KEYS);
  const before = pickNestedStringDeep(args, OLD_TEXT_KEYS);
  const after = pickNestedStringDeep(args, NEW_TEXT_KEYS);
  // pi 风格嵌套替换：{ path, edits:[{oldText,newText}] }（扁平 before/after 取不到时的主路径）。
  const edits = extractEdits(args);

  if (command || toolName === 'bash' || kind === 'execute' || /(shell|terminal|command|exec|run)/.test(toolName)) {
    const timeout = pickNestedNumber(args, ['timeout', 'timeoutMs']);
    return {
      label: '执行命令',
      subject: command || toolName || '命令',
      previewLabel: '命令',
      meta: timeout !== undefined ? [`timeout ${timeout}s`] : [],
      toolName: toolName || 'bash',
      category: 'command',
      sections: [
        ...(command
          ? [{ label: 'Shell', content: shellContent(command, block.rawOutput), kind: 'shell' as const }]
          : rawJsonSection(block.rawInput)),
      ],
    };
  }

  if (path && (before || after || edits.length > 0) && !/^(read|cat|view|open)/.test(toolName)) {
    const diff = edits.length > 0 ? makeEditsDiff(path, edits) : makeReplacementDiff(path, before, after);
    const stat = diffStats(diff);
    return {
      label: '编辑文件',
      subject: path,
      previewLabel: '目标',
      meta: stat ? [stat] : [],
      toolName: toolName || 'edit',
      category: 'edit',
      sections: [
        { label: 'Diff', content: diff, kind: 'diff' as const },
      ],
    };
  }

  if (path && content && !/^(read|cat|view|open)/.test(toolName)) {
    const lines = countContentLines(content);
    return {
      label: '写入文件',
      subject: path,
      previewLabel: '目标',
      meta: lines ? [`${lines} lines`] : [],
      toolName: toolName || 'write',
      category: 'write',
      sections: [
        { label: 'Content', content, kind: 'code' as const },
        ...outputSection(block.rawOutput),
      ],
    };
  }

  if (toolName === 'grep' || /^(grep|search)/.test(toolName)) {
    const pattern = pickString(args, ['pattern', 'query', 'regex']);
    const searchPath = pickString(args, PATH_KEYS) || '.';
    const subject = pattern ? `/${pattern}/ in ${searchPath}` : searchPath;
    return {
      label: '搜索',
      subject,
      previewLabel: '目标',
      meta: [],
      toolName: toolName || 'grep',
      category: 'search',
      sections: [...targetSection(subject), ...outputSection(block.rawOutput, 'Matches')],
    };
  }

  if (toolName === 'find' || toolName === 'glob') {
    const pattern = pickString(args, ['pattern', 'glob']) || '*';
    const searchPath = pickString(args, ['path', 'cwd']) || '.';
    const subject = `${pattern} in ${searchPath}`;
    return {
      label: '查找文件',
      subject,
      previewLabel: '目标',
      meta: [],
      toolName: toolName || 'find',
      category: 'search',
      sections: [...targetSection(subject), ...outputSection(block.rawOutput, 'Matches')],
    };
  }

  if (toolName === 'ls' || toolName === 'list') {
    const listPath = pickString(args, ['path', 'cwd']) || '.';
    return {
      label: '列出目录',
      subject: listPath,
      previewLabel: '目标',
      meta: [],
      toolName: toolName || 'ls',
      category: 'read',
      sections: [...targetSection(listPath), ...outputSection(block.rawOutput, 'Entries')],
    };
  }

  if (toolName === 'read' || kind === 'read' || /^(read|cat|view|open)/.test(toolName)) {
    const readPath = pickString(args, PATH_KEYS);
    const range = lineRange(args);
    const target = readPath ? `${readPath}${range}` : textValue(block.title) || '文件';
    return {
      label: '读取文件',
      subject: target,
      previewLabel: '目标',
      meta: [],
      toolName: toolName || 'read',
      category: 'read',
      sections: [...(hasInput || readPath ? targetSection(target) : []), ...outputSection(block.rawOutput)],
    };
  }

  if (toolName === 'edit' || /^(edit|patch|apply|replace)/.test(toolName)) {
    const patch = extractPatchText(args, block.rawInput);
    const editPath = pickNestedStringDeep(args, PATH_KEYS) || firstPathFromPatch(patch) || pathFromToolOutput(output);
    const editBefore = pickNestedStringDeep(args, OLD_TEXT_KEYS);
    const editAfter = pickNestedStringDeep(args, NEW_TEXT_KEYS);
    const diff = editPath && edits.length > 0
      ? makeEditsDiff(editPath, edits)
      : editPath && (editBefore || editAfter)
        ? makeReplacementDiff(editPath, editBefore, editAfter)
        : looksLikeUnifiedDiff(output)
          ? output
          : patch;
    const stat = diffStats(diff);
    return {
      label: '编辑文件',
      subject: editPath || '文件',
      previewLabel: '目标',
      meta: stat ? [stat] : [],
      toolName: toolName || 'edit',
      category: 'edit',
      sections: [
        ...(diff
          ? [{ label: 'Diff', content: diff, kind: 'diff' as const }]
          : [...rawJsonSection(block.rawInput), ...outputSection(block.rawOutput)]),
      ],
    };
  }

  if (toolName === 'write' || /^(write|create|overwrite)/.test(toolName)) {
    const writePath = pickNestedStringDeep(args, PATH_KEYS);
    const writeContent = pickNestedStringDeep(args, CONTENT_KEYS);
    const lines = countContentLines(writeContent);
    return {
      label: '写入文件',
      subject: writePath || '文件',
      previewLabel: '目标',
      meta: lines ? [`${lines} lines`] : [],
      toolName: toolName || 'write',
      category: 'write',
      sections: [
        ...(writeContent ? [{ label: 'Content', content: writeContent, kind: 'code' as const }] : rawJsonSection(block.rawInput)),
        ...outputSection(block.rawOutput),
      ],
    };
  }

  if (/^(delete|remove|rm|unlink)/.test(toolName)) {
    const path = pickNestedStringDeep(args, PATH_KEYS);
    return {
      label: '删除文件',
      subject: path || '文件',
      previewLabel: '目标',
      meta: [],
      toolName: toolName || 'delete',
      category: 'delete',
      sections: [
        ...targetSection(path || '文件'),
        ...outputSection(block.rawOutput),
      ],
    };
  }

  const fallbackLabel = textValue(block.title) || '工具调用';
  return {
    label: fallbackLabel,
    subject: pickString(args, [...PATH_KEYS, ...COMMAND_KEYS, 'query']) || fallbackLabel,
    previewLabel: '详情',
    meta: [],
    toolName: toolName || fallbackLabel,
    category: 'unknown',
    sections: [...rawJsonSection(block.rawInput), ...outputSection(block.rawOutput)],
  };
}

function looksLikeUnifiedDiff(output: string): boolean {
  return /(^|\n)(diff --git|---\s|@@\s-|[+-]{3}\s)/.test(output);
}

function extractPatchText(args: Record<string, unknown> | null, rawInput?: string): string {
  const explicit = pickNestedStringDeep(args, ['patch', 'diff']);
  if (explicit) return explicit;

  const raw = textValue(rawInput).trim();
  if (/^(\*\*\* Begin Patch|diff --git|\*\*\* (Update|Add|Delete) File:)/m.test(raw)) {
    return raw;
  }
  return '';
}

function firstPathFromPatch(patch: string): string {
  for (const line of patch.split('\n')) {
    const match =
      /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line) ||
      /^diff --git a\/(.+?) b\/.+$/.exec(line) ||
      /^\+\+\+ b\/(.+)$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function pathFromToolOutput(output: string): string {
  const match =
    /\bin\s+([^\s]+)\.?$/m.exec(output) ||
    /\b(?:Wrote|Created|Updated|Deleted)\s+([^\s]+)\.?$/im.exec(output) ||
    /^\s*[MAD]\s+(.+)$/m.exec(output);
  return match?.[1]?.trim().replace(/[.,;:]$/, '') ?? '';
}

function patchOperation(patch: string): 'edit' | 'create' | 'delete' {
  if (/^\*\*\* Add File:/m.test(patch)) return 'create';
  if (/^\*\*\* Delete File:/m.test(patch)) return 'delete';
  return 'edit';
}

export function fileChangeFromToolCall(block: ToolCallBlockLike): FileChangeDescriptor | null {
  const args = parseJsonObject(block.rawInput);
  const descriptor = describeToolCallBlock(block);
  const output = textValue(block.rawOutput);

  if (descriptor.category === 'edit') {
    const patch = extractPatchText(args, block.rawInput);
    const path = pickNestedStringDeep(args, PATH_KEYS) || firstPathFromPatch(patch) || pathFromToolOutput(output);
    if (!path) return null;
    const before = pickNestedStringDeep(args, OLD_TEXT_KEYS);
    const after = pickNestedStringDeep(args, NEW_TEXT_KEYS);
    const edits = extractEdits(args);
    const diff = edits.length > 0
      ? makeEditsDiff(path, edits)
      : before || after
        ? makeReplacementDiff(path, before, after)
        : looksLikeUnifiedDiff(output) ? output : patch || undefined;
    if (!before && !after && edits.length === 0 && !diff) return null;
    // edits[] 场景下扁平 before/after 取不到，用首条 edit 兜底 before/after 摘要。
    const firstEdit = edits[0];
    return {
      path,
      before: before || firstEdit?.oldText || null,
      after: after || firstEdit?.newText || '',
      diff,
      operation: patchOperation(patch),
    };
  }

  if (descriptor.category === 'write') {
    const path = pickNestedStringDeep(args, PATH_KEYS);
    if (!path) return null;
    const content = pickNestedStringDeep(args, CONTENT_KEYS);
    if (!content) return null;
    return {
      path,
      before: null,
      after: content || output,
      operation: 'create',
    };
  }

  if (descriptor.category === 'delete') {
    const path = pickNestedStringDeep(args, PATH_KEYS) || pathFromToolOutput(output);
    if (!path) return null;
    return {
      path,
      before: output || path,
      after: '',
      operation: 'delete',
    };
  }

  return null;
}
