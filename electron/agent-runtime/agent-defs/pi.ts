import type { AgentModel, RuntimeAgentDef } from '../types';

/** 合成的「跟随 CLI 配置」默认项，始终置顶。 */
const DEFAULT_MODEL_OPTION: AgentModel = { id: 'default', label: 'Default' };

/**
 * 兜底模型列表：default + 常见 provider 模型。
 * 作为静态 `models`，保证下拉首屏不再只有 Default。
 */
const PI_FALLBACK_MODELS: AgentModel[] = [
  DEFAULT_MODEL_OPTION,
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (anthropic)' },
  { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (anthropic)' },
  { id: 'openai/gpt-5', label: 'GPT-5 (openai)' },
  { id: 'openai/o4-mini', label: 'o4-mini (openai)' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (google)' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (google)' },
];

/**
 * pi 现以进程内 SDK（@earendil-works/pi-coding-agent）运行（见 pi-inprocess.ts），
 * 不再 spawn CLI。def 仅保留 UI 展示与 in-process 运行所需元数据：
 *   - model / reasoning 选项；model 实际列表由 buildPiModelOptions 按 App provider
 *     投影动态生成（见 acp/ipc.ts agent:list-models）。
 *   - inProcess: true → preflight 视其恒可用，无需安装探测。
 */
export const piAgentDef = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  inProcess: true,
  versionArgs: ['--version'],
  defaultModel: 'default',
  // 静态展示列表（首屏 / 非 electron 环境）；运行时由 provider 投影覆盖。
  models: PI_FALLBACK_MODELS,
  // 思考程度：映射到 pi 的 thinkingLevel 档位。'default' 表示跟随配置。
  defaultReasoning: 'default',
  reasoningOptions: [
    { id: 'default', label: '默认' },
    { id: 'off', label: '关闭' },
    { id: 'minimal', label: '极简' },
    { id: 'low', label: '低' },
    { id: 'medium', label: '中' },
    { id: 'high', label: '高' },
    { id: 'xhigh', label: '极高' },
  ],
} satisfies RuntimeAgentDef;
