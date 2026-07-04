import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AISettings, LLMProvider } from '../../types/ai';
import type { ResolvedBinding } from './binding-resolver';
import {
  extractReasoningContent,
  extractTextContent,
  parseLLMJsonResponse,
  parseStructuredOutput,
} from './content';
import { createChatModelFromProvider } from './model';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  isInsufficientCreditsError,
  isLingjiGatewayKey,
  normalizeCreditsError,
  normalizeCreditsErrorForKey,
} from './credits-error';

/** 解析本次调用实际使用的 provider apiKey（binding 优先，回落默认 provider）。 */
function resolveProviderApiKey(settings: AISettings, binding?: ResolvedBinding): string | undefined {
  return (
    binding?.provider?.apiKey ??
    settings.llmProviders?.find((p) => p.id === settings.defaultProviderId)?.apiKey
  );
}

export interface StreamCallbacks {
  onReasoningChunk?: (chunk: string) => void;
}

export { parseLLMJsonResponse };

function buildPromptMessages(systemPrompt: string, userMessage: string) {
  return [new SystemMessage(systemPrompt), new HumanMessage(userMessage)];
}

function assertNonEmptyContent(content: string, message: string): string {
  if (!content) {
    throw new Error(message);
  }

  return content;
}

function pickModel(settings: AISettings, binding?: ResolvedBinding) {
  if (binding) {
    // provider.enableThinking 缺省时由 createChatModelFromProvider 内部默认 true
    return createChatModelFromProvider(binding.provider, binding.model);
  }
  // 无 binding 时回落到默认 provider（旧的单 llmBaseUrl 路径已移除）
  const provider =
    settings.llmProviders?.find((p) => p.id === settings.defaultProviderId) ??
    settings.llmProviders?.[0];
  const model = settings.defaultModel ?? provider?.defaultModel ?? provider?.models[0];
  if (!provider || !model) {
    throw new Error('请先在「设置 → AI」中配置 LLM Provider 与模型');
  }
  return createChatModelFromProvider(provider, model);
}

// 轻量请求日志：主进程跑时输出到 `npm run dev` 终端，渲染进程跑时进 DevTools。
// 用于在卡片生成长时间无响应时判断是「等首字」还是「仍在持续输出」。
function llmLog(message: string): void {
  console.log(`[LLM ${new Date().toLocaleTimeString()}] ${message}`);
}

// 流式调用下不再用"总时长"做超时——只要 chunk（含 thinking 的 reasoning）
// 持续到达，就认为模型还在工作。idle 即"两个 chunk 之间最长允许的间隔"。
const STRUCTURED_IDLE_TIMEOUT_MS = 120_000;
const STRUCTURED_THINKING_IDLE_TIMEOUT_MS = 240_000;
// 总硬上限，仅作失控保护（流真的不结束时兜底）
const STRUCTURED_HARD_TIMEOUT_MS = 30 * 60_000;
const STRUCTURED_MAX_RETRIES = 2;
const STRUCTURED_RETRY_HINT =
  '\n\n【重要】上一次返回的不是合法 JSON 对象。请严格只输出一个完整的 JSON 对象，不要包裹 markdown 代码块、不要追加任何解释文字、不要省略闭合花括号。';

export interface StructuredDataOptions {
  // 可选：调用方可指定标签，用于错误信息定位（如 "cards.segment#3/12"）
  label?: string;
  // 可选：覆盖 idle 超时
  idleTimeoutMs?: number;
  // 可选：覆盖总硬上限
  hardTimeoutMs?: number;
  /** 可选：观测 hook（lib 层不直接依赖 electron，main 侧显式注入） */
  telemetry?: import('../telemetry/auto-run').TelemetryHook;
}

function isThinkingBinding(binding?: ResolvedBinding): boolean {
  if (!binding) return false;
  // provider.enableThinking 缺省视为 true（与 createChatModelFromProvider 保持一致）
  if (binding.provider.enableThinking === false) return false;
  // 或者模型名带常见 thinking 标识也视为 thinking
  const m = (binding.model || '').toLowerCase();
  return (
    binding.provider.enableThinking === true ||
    /(reason|think|r1|o1|o3|o4|qwq)/.test(m)
  );
}

interface StreamableModel {
  stream: (messages: unknown[]) => Promise<AsyncIterable<unknown>>;
  invoke?: (messages: unknown[]) => Promise<{ content: unknown }>;
}

interface BindableModel {
  bind?: (kwargs: Record<string, unknown>) => StreamableModel;
}

// 流式收集：每个 chunk 到达即重置 idle 计时；任意计时器触发就 abort 整体流
async function streamCollectWithIdleTimeout(
  model: StreamableModel,
  messages: unknown[],
  opts: {
    idleTimeoutMs: number;
    hardTimeoutMs: number;
    label: string;
    onFirstChunk?: (latencyMs: number) => void;
  },
): Promise<string> {
  const { idleTimeoutMs, hardTimeoutMs, label, onFirstChunk } = opts;
  let fullText = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | null = null;
  const startTs = Date.now();
  let firstChunkSeen = false;
  let chunkCount = 0;
  let lastBeatTs = startTs;
  const HEARTBEAT_MS = 5000;

  llmLog(`${label} 建立流式连接…（idle=${idleTimeoutMs}ms hard=${hardTimeoutMs}ms）`);
  const stream = await model.stream(messages);
  // 用 Async Iterator 接口拿到 return() 句柄，超时时主动关闭
  const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
  };

  const abort = (err: Error) => {
    timeoutError = err;
    // 主动关闭底层流，迭代会以 done 退出
    if (typeof iterator.return === 'function') {
      iterator.return(undefined).catch(() => undefined);
    }
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      llmLog(`${label} ⏱ 空闲超时：${idleTimeoutMs}ms 内未收到新输出（已收 ${chunkCount} chunks / ${fullText.length} chars）`);
      abort(new Error(`${label} 空闲超时（${idleTimeoutMs}ms 内未收到任何输出）`));
    }, idleTimeoutMs);
  };

  hardTimer = setTimeout(() => {
    llmLog(`${label} ⏱ 硬上限超时：总耗时超过 ${hardTimeoutMs}ms`);
    abort(new Error(`${label} 总耗时超过硬上限（${hardTimeoutMs}ms）`));
  }, hardTimeoutMs);
  armIdle();

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        const latencyMs = Date.now() - startTs;
        llmLog(`${label} ✓ 收到首个输出，首字延迟 ${latencyMs}ms`);
        onFirstChunk?.(latencyMs);
      }
      armIdle(); // 任意 chunk 到达即重置 idle，含 reasoning chunk
      chunkCount += 1;
      const chunk = next.value;
      const textChunk = extractTextContent((chunk as { content?: unknown })?.content);
      if (textChunk) fullText += textChunk;
      const now = Date.now();
      if (now - lastBeatTs >= HEARTBEAT_MS) {
        llmLog(`${label} … 接收中：${chunkCount} chunks / ${fullText.length} chars（已 ${Math.round((now - startTs) / 1000)}s）`);
        lastBeatTs = now;
      }
    }
  } finally {
    cleanup();
  }

  if (timeoutError) throw timeoutError;
  llmLog(`${label} ✔ 流式接收完成：${chunkCount} chunks / ${fullText.length} chars，耗时 ${Math.round((Date.now() - startTs) / 1000)}s`);
  return fullText;
}

/**
 * 流式调用 + 失败重试的通用核心。`parse` 把整段回复解析成业务结果；解析抛错即触发
 * 重试（附加 retryHint）。`bindJsonObject` 控制是否用 response_format=json_object 约束模型
 * —— 结构化 JSON 输出需要它，而自由 TSX 代码生成必须关闭它以保留模型自由度。
 */
async function streamWithRetry<T>(
  settings: AISettings,
  systemPrompt: string,
  userMessage: string,
  binding: ResolvedBinding | undefined,
  config: {
    parse: (content: string) => T | Promise<T>;
    /** 解析成功后的二次校验；抛错与解析失败一样触发重试（附加 retryHint）。 */
    validate?: (result: T) => void | Promise<void>;
    retryHint: string;
    bindJsonObject: boolean;
    label: string;
    telemetryLabel: string;
    failureMessage: string;
    options: StructuredDataOptions;
  },
): Promise<T> {
  const {
    parse,
    validate,
    retryHint,
    bindJsonObject,
    label,
    telemetryLabel,
    failureMessage,
    options,
  } = config;
  const chatModel = pickModel(settings, binding) as ReturnType<typeof createChatModelFromProvider> &
    BindableModel &
    StreamableModel;
  const model: StreamableModel =
    bindJsonObject && typeof chatModel.bind === 'function'
      ? chatModel.bind({ response_format: { type: 'json_object' } })
      : chatModel;

  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (isThinkingBinding(binding)
      ? STRUCTURED_THINKING_IDLE_TIMEOUT_MS
      : STRUCTURED_IDLE_TIMEOUT_MS);
  const hardTimeoutMs = options.hardTimeoutMs ?? STRUCTURED_HARD_TIMEOUT_MS;
  const thinking = isThinkingBinding(binding);
  const tel = options.telemetry;
  const gatewayKey = resolveProviderApiKey(settings, binding);

  let lastError: unknown;
  for (let attempt = 0; attempt <= STRUCTURED_MAX_RETRIES; attempt++) {
    const promptForAttempt = attempt === 0 ? systemPrompt : `${systemPrompt}${retryHint}`;
    const callStart = Date.now();
    llmLog(
      `${label} 发起请求 attempt=${attempt}/${STRUCTURED_MAX_RETRIES} ` +
        `model=${binding?.model ?? settings.defaultModel ?? 'default'} ` +
        `provider=${binding?.provider?.id ?? 'default'} thinking=${thinking} ` +
        `sys=${promptForAttempt.length} user=${userMessage.length} chars`,
    );
    tel?.emit('llm.start', {
      label: telemetryLabel,
      attempt,
      thinking,
      model: binding?.model ?? null,
      provider: binding?.provider?.id ?? null,
      systemChars: promptForAttempt.length,
      userChars: userMessage.length,
    });
    try {
      const fullText = await streamCollectWithIdleTimeout(
        model,
        buildPromptMessages(promptForAttempt, userMessage),
        {
          idleTimeoutMs,
          hardTimeoutMs,
          label,
          onFirstChunk: (latencyMs) => {
            tel?.emit('llm.firstChunk', { label: telemetryLabel, attempt, latencyMs });
          },
        },
      );
      const content = assertNonEmptyContent(fullText, 'LLM 返回空内容');
      const parsed = await parse(content);
      // 解析成功后的运行时校验（如 Motion Card 冒烟渲染）；抛错走重试。
      if (validate) await validate(parsed);
      llmLog(
        `${label} ✔ 成功 attempt=${attempt} 耗时=${Date.now() - callStart}ms 输出=${fullText.length} chars`,
      );
      tel?.emit('llm.end', {
        label: telemetryLabel,
        attempt,
        durationMs: Date.now() - callStart,
        outputChars: fullText.length,
        ok: true,
        retry: attempt > 0,
      });
      return parsed;
    } catch (error) {
      // 托管网关积分不足：重试无意义，补齐失败日志/遥测配对后直接给可行动的错误。
      if (isLingjiGatewayKey(gatewayKey) && isInsufficientCreditsError(error)) {
        llmLog(`${label} ✗ 积分不足 attempt=${attempt} 耗时=${Date.now() - callStart}ms`);
        tel?.emit('llm.end', {
          label: telemetryLabel,
          attempt,
          durationMs: Date.now() - callStart,
          ok: false,
          retry: attempt > 0,
          error: INSUFFICIENT_CREDITS_MESSAGE,
          willRetry: false,
        });
        throw normalizeCreditsError(error) as Error;
      }
      lastError = error;
      const willRetry = attempt < STRUCTURED_MAX_RETRIES;
      llmLog(
        `${label} ✗ 失败 attempt=${attempt} 耗时=${Date.now() - callStart}ms ` +
          `error=${error instanceof Error ? error.message : String(error)} willRetry=${willRetry}`,
      );
      tel?.emit('llm.end', {
        label: telemetryLabel,
        attempt,
        durationMs: Date.now() - callStart,
        ok: false,
        retry: attempt > 0,
        error: error instanceof Error ? error.message : String(error),
        willRetry,
      });
      // 仅在还有重试次数时继续；否则抛出最后一次错误
      if (attempt >= STRUCTURED_MAX_RETRIES) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(failureMessage);
}

export async function generateStructuredData(
  settings: AISettings,
  systemPrompt: string,
  userMessage: string,
  binding?: ResolvedBinding,
  options: StructuredDataOptions = {},
): Promise<Record<string, unknown>> {
  return streamWithRetry(settings, systemPrompt, userMessage, binding, {
    parse: parseStructuredOutput,
    retryHint: STRUCTURED_RETRY_HINT,
    bindJsonObject: true,
    label: `LLM 结构化输出请求${options.label ? `（${options.label}）` : ''}`,
    telemetryLabel: options.label ?? 'structured',
    failureMessage: 'LLM 结构化输出失败',
    options,
  });
}

// Motion Card TSX 生成已收敛到 pi 多 agent 编排器（electron/pipeline/motion-agent-run.ts，
// 导演→雕刻→审查，file-first）——旧的 generateMotionCardSource 直连流式路径已移除，无回退。

export async function generateText(
  settings: AISettings,
  systemPrompt: string,
  userMessage: string,
  binding?: ResolvedBinding,
): Promise<string> {
  try {
    const response = await pickModel(settings, binding).invoke(
      buildPromptMessages(systemPrompt, userMessage),
    );
    return assertNonEmptyContent(extractTextContent(response.content), 'LLM 返回空内容');
  } catch (error) {
    throw normalizeCreditsErrorForKey(resolveProviderApiKey(settings, binding), error);
  }
}

export async function streamText(
  settings: AISettings,
  systemPrompt: string,
  userMessage: string,
  onChunk: (chunk: string) => void,
  callbacks?: StreamCallbacks,
  binding?: ResolvedBinding,
  signal?: AbortSignal,
): Promise<string> {
  try {
    // signal 透传给底层 SDK fetch：用户取消时直接中断网络请求，而非仅停本地播放。
    const stream = await pickModel(settings, binding).stream(
      buildPromptMessages(systemPrompt, userMessage),
      signal ? { signal } : undefined,
    );
    let fullText = '';

    for await (const chunk of stream) {
      const reasoningChunk = extractReasoningContent(chunk);
      if (reasoningChunk) {
        callbacks?.onReasoningChunk?.(reasoningChunk);
      }

      const textChunk = extractTextContent(chunk.content);
      if (!textChunk) {
        continue;
      }

      fullText += textChunk;
      onChunk(textChunk);
    }

    return assertNonEmptyContent(fullText, 'LLM 流式返回空内容');
  } catch (error) {
    throw normalizeCreditsErrorForKey(resolveProviderApiKey(settings, binding), error);
  }
}

export async function streamTextWithProvider(
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  userMessage: string,
  onChunk: (chunk: string) => void,
  options?: { enableThinking?: boolean } & StreamCallbacks,
): Promise<string> {
  try {
    // 默认沿用 provider.enableThinking；调用方显式传入 options.enableThinking 时优先生效
    const chatModel = createChatModelFromProvider(provider, model, {
      enableThinking: options?.enableThinking,
    });
    const stream = await chatModel.stream(buildPromptMessages(systemPrompt, userMessage));
    let fullText = '';

    for await (const chunk of stream) {
      const reasoningChunk = extractReasoningContent(chunk);
      if (reasoningChunk) {
        options?.onReasoningChunk?.(reasoningChunk);
      }
      const textChunk = extractTextContent(chunk.content);
      if (!textChunk) continue;
      fullText += textChunk;
      onChunk(textChunk);
    }

    return assertNonEmptyContent(fullText, 'LLM 流式返回空内容');
  } catch (error) {
    throw normalizeCreditsErrorForKey(provider.apiKey, error);
  }
}
