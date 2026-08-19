import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  PiHeadlessSession,
  evaluateHeadlessToolGate,
  selectHeadlessModel,
  type PiHeadlessImage,
  type PiHeadlessStreamEvent,
} from '../electron/agent-runtime/pi-headless';

const CWD = '/tmp/work';

interface PiHeadlessHarness {
  onStreamEvent?: (event: PiHeadlessStreamEvent) => void;
  handleEvent: (event: AgentSessionEvent) => void;
}

describe('evaluateHeadlessToolGate（无头角色工具守卫）', () => {
  it('bash 类工具一律拦截', () => {
    for (const name of ['bash', 'shell', 'exec', 'run_command', 'terminal']) {
      const decision = evaluateHeadlessToolGate(name, { command: 'ls' }, { cwd: CWD, writeWithinDir: CWD });
      expect(decision?.block).toBe(true);
    }
  });

  it('read 等非写入工具放行', () => {
    expect(evaluateHeadlessToolGate('read', { path: '/etc/hosts' }, { cwd: CWD })).toBeUndefined();
  });

  it('write/edit 在未开放写入目录的角色上拦截', () => {
    expect(evaluateHeadlessToolGate('write', { path: 'motionCard.tsx' }, { cwd: CWD })?.block).toBe(true);
  });

  it('write/edit 目标落在 writeWithinDir 内放行（相对与绝对路径）', () => {
    const opts = { cwd: CWD, writeWithinDir: CWD };
    expect(evaluateHeadlessToolGate('write', { path: 'motionCard.tsx' }, opts)).toBeUndefined();
    expect(evaluateHeadlessToolGate('edit', { path: `${CWD}/motionCard.tsx` }, opts)).toBeUndefined();
    expect(evaluateHeadlessToolGate('write', { file_path: `${CWD}/sub/a.tsx` }, opts)).toBeUndefined();
  });

  it('write/edit 目标越界拦截（含 .. 逃逸与前缀伪装）', () => {
    const opts = { cwd: CWD, writeWithinDir: CWD };
    expect(evaluateHeadlessToolGate('write', { path: '../outside.tsx' }, opts)?.block).toBe(true);
    expect(evaluateHeadlessToolGate('write', { path: '/tmp/work2/evil.tsx' }, opts)?.block).toBe(true);
    expect(evaluateHeadlessToolGate('edit', { path: '/etc/passwd' }, opts)?.block).toBe(true);
  });

  it('写入目标缺失时拦截', () => {
    expect(
      evaluateHeadlessToolGate('write', {}, { cwd: CWD, writeWithinDir: CWD })?.block,
    ).toBe(true);
  });
});

describe('PiHeadlessSession multimodal prompt', () => {
  it('passes Pi SDK ImageContent with flat data and mimeType fields', async () => {
    const sdkPrompt = vi.fn().mockResolvedValue(undefined);
    const session = new PiHeadlessSession();
    (session as unknown as { session: { prompt: typeof sdkPrompt } }).session = { prompt: sdkPrompt };
    const images: PiHeadlessImage[] = [
      {
        type: 'image',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      },
      {
        type: 'image',
        data: 'd29ybGQ=',
        mimeType: 'image/jpeg',
      },
    ];

    await session.prompt('检查这张冻结素材', images);

    expect(sdkPrompt).toHaveBeenCalledWith('检查这张冻结素材', {
      images,
    });
  });

  it('keeps the text-only SDK prompt path free of image options', async () => {
    const sdkPrompt = vi.fn().mockResolvedValue(undefined);
    const session = new PiHeadlessSession();
    (session as unknown as { session: { prompt: typeof sdkPrompt } }).session = { prompt: sdkPrompt };

    await session.prompt('只检查文字', []);

    expect(sdkPrompt).toHaveBeenCalledWith('只检查文字');
  });
});

describe('selectHeadlessModel', () => {
  const models = new Map([
    ['text-provider/text-model', { id: 'text-model', input: ['text'] }],
    ['vision-provider/vision-model', { id: 'vision-model', input: ['text', 'image'] }],
  ]);
  const runtime = {
    getModel: (provider: string, modelId: string) => models.get(`${provider}/${modelId}`),
  };

  it('skips text-only candidates and selects the first image-capable runtime model', () => {
    expect(selectHeadlessModel(runtime, {
      model: 'text-provider/text-model',
      modelCandidates: ['text-provider/text-model', 'vision-provider/vision-model'],
      requireImageInput: true,
    })).toMatchObject({ id: 'vision-model' });
  });

  it('fails before session creation when a visual role has no image-capable model', () => {
    expect(() => selectHeadlessModel(runtime, {
      modelCandidates: ['text-provider/text-model', 'missing/model'],
      requireImageInput: true,
    })).toThrow('需要支持图片输入的模型');
  });

  it('preserves the legacy text-only model selection path for non-visual roles', () => {
    expect(selectHeadlessModel(runtime, { model: 'text-provider/text-model' }))
      .toMatchObject({ id: 'text-model' });
  });

  it('walks text-role candidates when the first reference is missing from Pi runtime', () => {
    expect(selectHeadlessModel(runtime, {
      model: 'missing/model',
      modelCandidates: ['missing/model', 'text-provider/text-model'],
    })).toMatchObject({ id: 'text-model' });
  });
});

describe('PiHeadlessSession turn telemetry', () => {
  it('emits exact turn metrics without assistant or thinking text', () => {
    const assistantText = 'SECRET_ASSISTANT_BODY';
    const assistantContinuation = '_CONTINUED';
    const thinkingText = 'SECRET_THINKING_BODY';
    const events: PiHeadlessStreamEvent[] = [];
    const harness = new PiHeadlessSession() as unknown as PiHeadlessHarness;
    harness.onStreamEvent = (event) => events.push(event);

    harness.handleEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: assistantText },
          { type: 'thinking', thinking: thinkingText },
          { type: 'text', text: assistantContinuation },
          { type: 'toolCall', id: 'call-1', name: 'director_get_context', arguments: {} },
        ],
        stopReason: 'length',
        errorMessage: 'SECRET_PROVIDER_ERROR',
        usage: {
          input: 120,
          output: 40,
          cacheRead: 50,
          cacheWrite: 30,
          reasoning: 12,
          totalTokens: 260,
        },
      },
      toolResults: [],
    } as unknown as AgentSessionEvent);

    expect(events).toEqual([{
      type: 'turn_end',
      stopReason: 'length',
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 50,
      cacheWriteTokens: 30,
      reasoningTokens: 12,
      contextTokens: 260,
      assistantChars: assistantText.length + assistantContinuation.length,
      thinkingChars: thinkingText.length,
    }]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(assistantText);
    expect(serialized).not.toContain(thinkingText);
    expect(serialized).not.toContain('SECRET_PROVIDER_ERROR');
  });

  it('derives context tokens from available usage components when totalTokens is zero', () => {
    const events: PiHeadlessStreamEvent[] = [];
    const harness = new PiHeadlessSession() as unknown as PiHeadlessHarness;
    harness.onStreamEvent = (event) => events.push(event);

    harness.handleEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'toolUse',
        usage: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 0,
        },
      },
      toolResults: [],
    } as unknown as AgentSessionEvent);

    expect(events).toEqual([{
      type: 'turn_end',
      stopReason: 'toolUse',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      contextTokens: 10,
      assistantChars: 0,
      thinkingChars: 0,
    }]);
  });
});
