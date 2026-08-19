import { describe, expect, it } from 'vitest';
import {
  applyIngestTraceEvent,
  emptyIngestTrace,
  ingestToolLabel,
  summarizeIngestToolResult,
} from '../src/lib/publish/ingest-trace';

describe('ingest trace', () => {
  it('扫描、思考、工具调用按时间线合并', () => {
    let state = emptyIngestTrace();
    state = applyIngestTraceEvent(state, { type: 'scan', summary: '成片 a.mp4 · 封面 16:9' });
    state = applyIngestTraceEvent(state, { type: 'thinking_delta', delta: '先看' });
    state = applyIngestTraceEvent(state, { type: 'thinking_delta', delta: '摘录' });
    state = applyIngestTraceEvent(state, {
      type: 'tool_use',
      id: '1',
      name: 'publish_generate_metadata',
      label: ingestToolLabel('publish_generate_metadata'),
    });
    state = applyIngestTraceEvent(state, {
      type: 'tool_result',
      id: '1',
      name: 'publish_generate_metadata',
      ok: true,
      summary: '标题：一期',
    });
    state = applyIngestTraceEvent(state, { type: 'text_delta', delta: '已采用物料标题' });
    state = applyIngestTraceEvent(state, { type: 'done' });
    expect(state.scanSummary).toContain('a.mp4');
    expect(state.blocks).toEqual([
      { type: 'thinking', text: '先看摘录' },
      {
        type: 'tool_call',
        toolCallId: '1',
        title: '生成标题简介',
        kind: 'publish_generate_metadata',
        status: 'completed',
        rawOutput: '标题：一期',
      },
      { type: 'text', text: '已采用物料标题' },
    ]);
    expect(state.streaming).toBe(false);
  });

  it('工具结果摘要不含长文案', () => {
    expect(summarizeIngestToolResult(JSON.stringify({
      ok: true,
      title: '短标题',
      sourceText: '这是一段很长的口播不应该出现在界面摘要里',
    }))).toBe('标题：短标题');
    expect(summarizeIngestToolResult(JSON.stringify({ ok: true }))).toBe('完成');
  });
});
