import type { ConversationBlock } from '../../types/conversation';

export const PUBLISH_INGEST_TOOL_LABELS: Record<string, string> = {
  publish_get_context: '读取上下文',
  publish_read_text: '阅读文案',
  publish_generate_metadata: '生成标题简介',
  publish_generate_cover_prompt: '生成封面提示词',
  publish_recommend_partition: '推荐 B 站分区',
  publish_validate_draft: '校验草案',
  publish_submit_draft: '提交草案',
};

export type PublishIngestTraceEvent =
  | { type: 'scan'; summary: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; label?: string }
  | { type: 'tool_result'; id: string; name?: string; ok: boolean; summary?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface IngestTraceState {
  scanSummary: string | null;
  blocks: ConversationBlock[];
  streaming: boolean;
}

export function emptyIngestTrace(): IngestTraceState {
  return { scanSummary: null, blocks: [], streaming: false };
}

export function ingestToolLabel(name: string): string {
  return PUBLISH_INGEST_TOOL_LABELS[name] ?? name;
}

function lastBlock<T extends ConversationBlock['type']>(
  blocks: ConversationBlock[],
  type: T,
): Extract<ConversationBlock, { type: T }> | null {
  const last = blocks[blocks.length - 1];
  return last?.type === type ? last as Extract<ConversationBlock, { type: T }> : null;
}

export function summarizeIngestToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 200);
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 200);
    if (typeof parsed.title === 'string' && parsed.title.trim()) return `标题：${parsed.title.trim()}`;
    if (typeof parsed.path === 'string' && parsed.path.trim()) return parsed.path.trim();
    if (parsed.ok === false) return '未通过';
    if (parsed.ok === true) return '完成';
  } catch {
    // fall through
  }
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 120);
}

export function applyIngestTraceEvent(
  state: IngestTraceState,
  event: PublishIngestTraceEvent,
): IngestTraceState {
  if (event.type === 'scan') {
    return { ...state, scanSummary: event.summary, streaming: true };
  }
  if (event.type === 'done') {
    return { ...state, streaming: false };
  }
  if (event.type === 'error') {
    return {
      ...state,
      streaming: false,
      blocks: [...state.blocks, { type: 'error', message: event.message }],
    };
  }
  if (event.type === 'thinking_delta') {
    const current = lastBlock(state.blocks, 'thinking');
    if (current) {
      return {
        ...state,
        streaming: true,
        blocks: [...state.blocks.slice(0, -1), { type: 'thinking', text: current.text + event.delta }],
      };
    }
    return {
      ...state,
      streaming: true,
      blocks: [...state.blocks, { type: 'thinking', text: event.delta }],
    };
  }
  if (event.type === 'text_delta') {
    const current = lastBlock(state.blocks, 'text');
    if (current) {
      return {
        ...state,
        streaming: true,
        blocks: [...state.blocks.slice(0, -1), { type: 'text', text: current.text + event.delta }],
      };
    }
    return {
      ...state,
      streaming: true,
      blocks: [...state.blocks, { type: 'text', text: event.delta }],
    };
  }
  if (event.type === 'tool_use') {
    return {
      ...state,
      streaming: true,
      blocks: [
        ...state.blocks,
        {
          type: 'tool_call',
          toolCallId: event.id,
          title: event.label || ingestToolLabel(event.name),
          kind: event.name,
          status: 'running',
        },
      ],
    };
  }
  if (event.type !== 'tool_result') return state;
  let updated = false;
  const next = state.blocks.map((block) => {
    if (block.type !== 'tool_call') return block;
    const match = block.toolCallId === event.id
      || (!updated && block.status === 'running' && event.name != null && block.kind === event.name);
    if (!match) return block;
    updated = true;
    return {
      ...block,
      status: event.ok ? 'completed' : 'failed',
      rawOutput: event.summary,
    };
  });
  return { ...state, streaming: true, blocks: next };
}
