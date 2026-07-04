import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { LMSTUDIO_DEFAULT_BASE_URL, type AISettings, type LLMProvider } from '../../types/ai';

/** MiniMax Anthropic 兼容端点默认地址（SDK 会在其后拼 /v1/messages）。 */
export const MINIMAX_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.minimaxi.com/anthropic';
/** 火山方舟标准 Chat 端点（ChatOpenAI 会在其后拼 /chat/completions）。 */
export const VOLCENGINE_ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** Anthropic 扩展思考的最小 budget_tokens（小于此值接口会报错）。 */
const MINIMAX_MIN_THINKING_BUDGET = 1024;
/** 正文 token 预算：thinking 之外留给真正回答（TSX 卡片）的空间，过小会截断成黑屏。 */
const MINIMAX_CONTENT_TOKENS = 8192;

export type MiniMaxThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number };

/**
 * 由 enableThinking + 思考深度解析出 MiniMax(Anthropic) 的 thinking 配置。
 * 关闭 → disabled；开启 → enabled 且 budget_tokens 至少 1024（Anthropic 下限）。
 */
export function resolveMiniMaxThinking(
  enableThinking: boolean,
  budgetTokens?: number,
): MiniMaxThinkingConfig {
  if (enableThinking === false) {
    return { type: 'disabled' };
  }
  const requested =
    typeof budgetTokens === 'number' && Number.isFinite(budgetTokens) && budgetTokens > 0
      ? Math.floor(budgetTokens)
      : MINIMAX_MIN_THINKING_BUDGET;
  return { type: 'enabled', budget_tokens: Math.max(MINIMAX_MIN_THINKING_BUDGET, requested) };
}

/** max_tokens 必须严格大于 thinking.budget_tokens，并为正文留足空间。 */
export function resolveMiniMaxMaxTokens(thinking: MiniMaxThinkingConfig): number {
  const budget = thinking.type === 'enabled' ? thinking.budget_tokens : 0;
  return budget + MINIMAX_CONTENT_TOKENS;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveEnableThinking(
  provider: LLMProvider,
  options?: { enableThinking?: boolean },
): boolean {
  if (options && options.enableThinking !== undefined) {
    return options.enableThinking;
  }
  return provider.enableThinking ?? true;
}

function createGeminiChatModel(
  provider: LLMProvider,
  model: string,
  options?: { enableThinking?: boolean },
): ChatGoogleGenerativeAI {
  const trimmedBaseUrl = provider.baseUrl?.trim();
  const enableThinking = resolveEnableThinking(provider, options);
  return new ChatGoogleGenerativeAI({
    apiKey: provider.apiKey,
    model,
    temperature: 0.3,
    ...(trimmedBaseUrl ? { baseUrl: normalizeBaseUrl(trimmedBaseUrl) } : {}),
    ...(enableThinking === false ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  });
}

/**
 * MiniMax 专用适配：走 MiniMax 的 Anthropic 兼容端点（/anthropic → /v1/messages），
 * 这是 MiniMax 唯一能真正控制思考的路径——OpenAI 兼容端点会忽略 enable_thinking。
 * thinking 开关 + 思考深度(budget_tokens) 映射到 Anthropic 的 thinking 配置。
 */
function createMiniMaxChatModel(
  provider: LLMProvider,
  model: string,
  options?: { enableThinking?: boolean },
): BaseChatModel {
  const enableThinking = resolveEnableThinking(provider, options);
  const thinking = resolveMiniMaxThinking(enableThinking, provider.thinkingBudgetTokens);
  const maxTokens = resolveMiniMaxMaxTokens(thinking);
  const baseUrl = normalizeBaseUrl(provider.baseUrl?.trim() || MINIMAX_ANTHROPIC_DEFAULT_BASE_URL);

  return new ChatAnthropic({
    apiKey: provider.apiKey,
    model,
    anthropicApiUrl: baseUrl,
    maxTokens,
    // Anthropic 扩展思考开启时要求 temperature=1；关闭思考时用低温更稳。
    temperature: thinking.type === 'enabled' ? 1 : 0.3,
    thinking,
    // MiniMax 的 Anthropic 端点非流式响应 content 为 null，会让 ChatAnthropic 在
    // anthropicResponseToChatMessages 里读 null.length 崩溃（连接测试 invoke() 即触发）。
    // 强制 streaming：invoke() 也走流式聚合路径，与真实生成（model.stream）一致。
    streaming: true,
    // 主进程为 Node，此处保险允许在类浏览器环境（渲染进程）下实例化。
    clientOptions: { dangerouslyAllowBrowser: true },
  }) as unknown as BaseChatModel;
}

/**
 * 火山引擎方舟专用适配：火山是 OpenAI 兼容端点（/api/v3/chat/completions），
 * 底层复用 ChatOpenAI，火山特有参数（thinking / reasoning_effort / service_tier）经 modelKwargs 透传。
 * 思考门控：master gate（options/provider.enableThinking===false）→ 强制 thinking.type='disabled'；
 * 否则用 volcengineArk.thinkingMode（缺省 enabled）。保持「流水线步骤强制关思考」的调用约定。
 */
function createVolcengineArkChatModel(
  provider: LLMProvider,
  model: string,
  options?: { enableThinking?: boolean },
): BaseChatModel {
  const ark = provider.volcengineArk ?? {};
  const gateOpen = resolveEnableThinking(provider, options);
  const thinkingType = gateOpen ? (ark.thinkingMode ?? 'enabled') : 'disabled';

  const modelKwargs: Record<string, unknown> = {
    thinking: { type: thinkingType },
  };
  if (ark.reasoningEffort) modelKwargs.reasoning_effort = ark.reasoningEffort;
  if (ark.serviceTier) modelKwargs.service_tier = ark.serviceTier;

  const apiKey = provider.apiKey;
  const baseURL = normalizeBaseUrl(provider.baseUrl?.trim() || VOLCENGINE_ARK_DEFAULT_BASE_URL);

  return new ChatOpenAI({
    apiKey,
    model,
    temperature: 0.3,
    configuration: {
      apiKey,
      baseURL,
    },
    modelKwargs,
  });
}

export function createChatModelFromProvider(
  provider: LLMProvider,
  model: string,
  options?: { enableThinking?: boolean },
): BaseChatModel {
  if (provider.type === 'gemini') {
    return createGeminiChatModel(provider, model, options);
  }

  if (provider.type === 'minimax') {
    return createMiniMaxChatModel(provider, model, options);
  }

  if (provider.type === 'volcengine_ark') {
    return createVolcengineArkChatModel(provider, model, options);
  }

  const enableThinking = resolveEnableThinking(provider, options);
  // LM Studio 走 OpenAI 兼容端点；apiKey 留空时填充占位值，避免 SDK 抛错
  const isLMStudio = provider.type === 'lmstudio';
  // openai_responses：走 OpenAI 的 /v1/responses 协议，其余 baseURL/apiKey 处理与
  // openai_compatible 一致，仅在 ChatOpenAI 上打开 useResponsesApi。
  const useResponsesApi = provider.type === 'openai_responses';
  const apiKey = provider.apiKey?.trim() || (isLMStudio ? 'lm-studio' : provider.apiKey);
  const baseURL = normalizeBaseUrl(provider.baseUrl?.trim() || (isLMStudio ? LMSTUDIO_DEFAULT_BASE_URL : provider.baseUrl));

  const modelKwargs =
    enableThinking === false
      ? { enable_thinking: false }
      : undefined;

  return new ChatOpenAI({
    apiKey,
    model,
    temperature: 0.3,
    ...(useResponsesApi ? { useResponsesApi: true } : {}),
    configuration: {
      apiKey,
      baseURL,
    },
    ...(modelKwargs ? { modelKwargs } : {}),
  });
}
