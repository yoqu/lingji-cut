import { useState } from 'react';
import {
  LMSTUDIO_DEFAULT_BASE_URL,
  type LLMProvider,
  type PiProviderApi,
  type PiThinkingFormat,
} from '../../types/ai';
import { CLAUDE_CODE_ACP_DEFAULT_MODEL } from '../../lib/llm/claude-code-acp-model';
import { fetchProviderModels } from '../../lib/llm/fetch-models';
import {
  CUSTOM_PROVIDER_PRESET_ID,
  PI_PROVIDER_PRESETS,
  applyPiProviderPreset,
  findPiProviderPresetByBuiltinId,
  getPiBuiltinProviderId,
} from '../../lib/llm/pi-provider-presets';
import { testProviderModel } from '../../lib/llm/test-provider';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  ModalFooter,
  Select,
  Switch,
  Textarea,
  DialogFooter,
} from '../../ui';
import type { SelectOption } from '../../ui';
import { normalizeProviderDraft, validateProviderDraft } from './ai-config-utils';
import { LingjiGatewayConnect } from './LingjiGatewayConnect';
import styles from './ProviderListSection.module.css';

/** 生成唯一 ID */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const PROVIDER_TYPE_OPTIONS: SelectOption[] = [
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'lmstudio', label: 'LM Studio (本地)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'minimax', label: 'MiniMax (Anthropic 端点)' },
  { value: 'volcengine_ark', label: '火山引擎方舟' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'claude_code_acp', label: 'Claude Code ACP' },
];

const QUICK_PROVIDER_OPTIONS: SelectOption[] = [
  ...PI_PROVIDER_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.label,
  })),
  { value: CUSTOM_PROVIDER_PRESET_ID, label: '自定义 Provider' },
];

const PI_API_OPTIONS: SelectOption[] = [
  { value: '', label: '自动匹配 Provider 类型' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

const PI_MAX_TOKENS_FIELD_OPTIONS: SelectOption[] = [
  { value: 'max_tokens', label: 'max_tokens' },
  { value: 'max_completion_tokens', label: 'max_completion_tokens' },
];

const PI_THINKING_FORMAT_OPTIONS: SelectOption[] = [
  { value: '', label: '默认' },
  { value: 'openai', label: 'OpenAI reasoning_effort' },
  { value: 'openrouter', label: 'OpenRouter reasoning' },
  { value: 'deepseek', label: 'DeepSeek thinking' },
  { value: 'together', label: 'Together reasoning' },
  { value: 'zai', label: 'ZAI thinking' },
  { value: 'qwen', label: 'Qwen enable_thinking' },
  { value: 'qwen-chat-template', label: 'Qwen chat template' },
];

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const MINIMAX_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.minimaxi.com/anthropic';
const VOLCENGINE_ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** MiniMax 思考深度默认值（token），与 model.ts 下限保持一致 */
const MINIMAX_DEFAULT_THINKING_BUDGET = 1024;

/** 火山方舟深度思考模式选项 */
const ARK_THINKING_MODE_OPTIONS: SelectOption[] = [
  { value: 'enabled', label: '开启（强制思考）' },
  { value: 'disabled', label: '关闭（直接回答）' },
  { value: 'auto', label: '自动（模型自行判断）' },
];
/** 火山方舟思考力度选项；空值＝跟随 API 默认（medium），不下发 */
const ARK_REASONING_EFFORT_OPTIONS: SelectOption[] = [
  { value: '', label: '跟随默认（medium）' },
  { value: 'minimal', label: 'minimal（关闭思考，直接回答）' },
  { value: 'low', label: 'low（轻量思考，快速响应）' },
  { value: 'medium', label: 'medium（均衡）' },
  { value: 'high', label: 'high（深度分析）' },
  { value: 'max', label: 'max（最高强度，仅部分模型）' },
];
/** 火山方舟在线推理模式选项；空值＝跟随 API 默认（auto），不下发 */
const ARK_SERVICE_TIER_OPTIONS: SelectOption[] = [
  { value: '', label: '跟随默认（auto）' },
  { value: 'fast', label: 'fast（低延迟）' },
  { value: 'auto', label: 'auto（TPM 保障包优先）' },
  { value: 'default', label: 'default（常规）' },
];
const DEFAULT_PI_CONTEXT_WINDOW = 128000;
const DEFAULT_PI_MAX_TOKENS = 8192;

function updatePiSettings(
  provider: LLMProvider,
  updater: (pi: NonNullable<LLMProvider['pi']>) => NonNullable<LLMProvider['pi']>,
): LLMProvider {
  const nextPi = updater(provider.pi ?? {});
  return { ...provider, pi: Object.keys(nextPi).length > 0 ? nextPi : undefined };
}

function updatePiCompat(
  provider: LLMProvider,
  updater: (
    compat: NonNullable<NonNullable<LLMProvider['pi']>['compat']>,
  ) => NonNullable<NonNullable<LLMProvider['pi']>['compat']>,
): LLMProvider {
  return updatePiSettings(provider, (pi) => {
    const nextCompat = updater(pi.compat ?? {});
    const nextPi = { ...pi };
    if (Object.keys(nextCompat).length > 0) nextPi.compat = nextCompat;
    else delete nextPi.compat;
    return nextPi;
  });
}

function updatePiModel(
  provider: LLMProvider,
  updater: (
    model: NonNullable<NonNullable<LLMProvider['pi']>['model']>,
  ) => NonNullable<NonNullable<LLMProvider['pi']>['model']>,
): LLMProvider {
  return updatePiSettings(provider, (pi) => {
    const nextModel = updater(pi.model ?? {});
    const nextPi = { ...pi };
    if (Object.keys(nextModel).length > 0) nextPi.model = nextModel;
    else delete nextPi.model;
    return nextPi;
  });
}

function parseHeadersText(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (key && value) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function formatHeadersText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** 空白 Provider 表单 */
function emptyProvider(): LLMProvider {
  return applyPiProviderPreset(
    {
      id: genId(),
      name: '',
      type: 'openai_compatible',
      baseUrl: '',
      apiKey: '',
      models: [],
      enableThinking: true,
    },
    PI_PROVIDER_PRESETS[0],
  );
}

function inferPresetId(provider: LLMProvider): string {
  const fromPi = findPiProviderPresetByBuiltinId(getPiBuiltinProviderId(provider));
  if (fromPi) return fromPi.id;
  if (provider.pi) return CUSTOM_PROVIDER_PRESET_ID;
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
  const byShape = PI_PROVIDER_PRESETS.find((preset) => {
    const presetBaseUrl = preset.baseUrl.trim().replace(/\/+$/, '');
    return preset.type === provider.type && presetBaseUrl === baseUrl;
  });
  return byShape?.id ?? CUSTOM_PROVIDER_PRESET_ID;
}

// ─── 子组件：Provider 编辑弹窗 ────────────────────────────────────────────

interface DialogProps {
  initial: LLMProvider;
  isDefault: boolean;
  onSave: (p: LLMProvider, isDefault: boolean) => void;
  onCancel: () => void;
}

type FetchPickerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; fetched: string[]; selected: Set<string> };

type ModelTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; message: string };

function truncateErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized;
}

function ProviderDialog({ initial, isDefault, onSave, onCancel }: DialogProps) {
  const initialPresetId = inferPresetId(initial);
  const [form, setForm] = useState<LLMProvider>(() => {
    const base = {
      ...initial,
      enableThinking: initial.enableThinking ?? true,
    };
    const preset = PI_PROVIDER_PRESETS.find((item) => item.id === initialPresetId);
    return preset ? applyPiProviderPreset(base, preset) : base;
  });
  const [piHeadersText, setPiHeadersText] = useState(formatHeadersText(initial.pi?.headers));
  const [presetId, setPresetId] = useState(initialPresetId);
  const [showAdvanced, setShowAdvanced] = useState(
    () => initialPresetId === CUSTOM_PROVIDER_PRESET_ID,
  );
  const [setAsDefault, setSetAsDefault] = useState(isDefault);
  const [newModel, setNewModel] = useState('');
  const [errors, setErrors] = useState<ReturnType<typeof validateProviderDraft>>({});
  const [picker, setPicker] = useState<FetchPickerState>({ status: 'idle' });
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>({});
  const title = initial.name ? '编辑 Provider' : '添加 Provider';
  const isClaudeCodeAcp = form.type === 'claude_code_acp';
  const isVolcengineArk = form.type === 'volcengine_ark';
  const selectedPreset = PI_PROVIDER_PRESETS.find((preset) => preset.id === presetId) ?? null;
  const isQuickPreset = Boolean(selectedPreset && selectedPreset.id !== CUSTOM_PROVIDER_PRESET_ID);

  const updateModelTest = (model: string, state: ModelTestState) =>
    setModelTests((prev) => ({ ...prev, [model]: state }));

  const handleTestModel = async (model: string) => {
    updateModelTest(model, { status: 'testing' });
    try {
      const { latencyMs } = await testProviderModel(form, model);
      updateModelTest(model, { status: 'ok', latencyMs });
    } catch (error) {
      updateModelTest(model, {
        status: 'error',
        message: truncateErrorMessage(
          error instanceof Error ? error.message : '未知错误',
        ),
      });
    }
  };

  const clearFieldError = (key: keyof ReturnType<typeof validateProviderDraft>) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const set = <K extends keyof LLMProvider>(
    key: K,
    value: LLMProvider[K],
    errorKey?: keyof ReturnType<typeof validateProviderDraft>,
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errorKey) {
      clearFieldError(errorKey);
    }
  };

  /** 更新火山方舟专属参数；value 为空串时删除该键（回落 API 默认）。 */
  const setArk = <K extends keyof NonNullable<LLMProvider['volcengineArk']>>(
    key: K,
    value: NonNullable<LLMProvider['volcengineArk']>[K] | undefined,
  ) => {
    setForm((f) => {
      const nextArk = { ...(f.volcengineArk ?? {}) };
      if (value === undefined) {
        delete nextArk[key];
      } else {
        nextArk[key] = value;
      }
      return { ...f, volcengineArk: Object.keys(nextArk).length > 0 ? nextArk : undefined };
    });
  };

  const handlePresetChange = (value: string) => {
    setPresetId(value);
    setModelTests({});
    setPicker({ status: 'idle' });
    clearFieldError('name');
    clearFieldError('baseUrl');
    clearFieldError('apiKey');
    clearFieldError('models');

    if (value === CUSTOM_PROVIDER_PRESET_ID) {
      setShowAdvanced(true);
      setForm((f) => {
        const nextPi = { ...(f.pi ?? {}) };
        delete nextPi.builtinProviderId;
        return {
          ...f,
          pi: Object.keys(nextPi).length > 0 ? nextPi : undefined,
        };
      });
      return;
    }

    const preset = PI_PROVIDER_PRESETS.find((item) => item.id === value);
    if (!preset) return;
    setForm((f) => {
      const next = applyPiProviderPreset(
        {
          ...f,
          name: preset.providerName,
          baseUrl: preset.baseUrl,
          models: preset.models,
          enableThinking: preset.enableThinking,
        },
        preset,
      );
      if (!preset.apiKeyRequired && !next.apiKey.trim()) {
        next.apiKey = '';
      }
      return next;
    });
  };

  const addModel = () => {
    const m = newModel.trim();
    if (m && !form.models.includes(m)) {
      set('models', [...form.models, m], 'models');
    }
    setNewModel('');
  };

  const removeModel = (idx: number) => {
    const removed = form.models[idx];
    set(
      'models',
      form.models.filter((_, i) => i !== idx),
      'models',
    );
    if (removed) {
      setModelTests((prev) => {
        if (!(removed in prev)) return prev;
        const next = { ...prev };
        delete next[removed];
        return next;
      });
    }
  };

  const handleFetchModels = async () => {
    setPicker({ status: 'loading' });
    try {
      const fetched = await fetchProviderModels(form);
      if (fetched.length === 0) {
        setPicker({ status: 'error', message: '远端返回了空模型列表' });
        return;
      }
      const existing = new Set(form.models);
      const candidates = fetched.filter((id) => !existing.has(id));
      if (candidates.length === 0) {
        setPicker({ status: 'error', message: '所有可拉取的模型都已存在' });
        return;
      }
      setPicker({
        status: 'ready',
        fetched: candidates,
        selected: new Set(candidates),
      });
    } catch (error) {
      setPicker({
        status: 'error',
        message: error instanceof Error ? error.message : '拉取失败',
      });
    }
  };

  const togglePickerSelection = (id: string) => {
    setPicker((prev) => {
      if (prev.status !== 'ready') return prev;
      const next = new Set(prev.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, selected: next };
    });
  };

  const setAllPickerSelection = (all: boolean) => {
    setPicker((prev) => {
      if (prev.status !== 'ready') return prev;
      return { ...prev, selected: new Set(all ? prev.fetched : []) };
    });
  };

  const applyPickerSelection = () => {
    if (picker.status !== 'ready' || picker.selected.size === 0) return;
    const merged = Array.from(new Set([...form.models, ...picker.selected]));
    set('models', merged, 'models');
    setPicker({ status: 'idle' });
  };

  const handleConfirm = () => {
    const pendingModel = newModel.trim();
    const withPendingModel =
      pendingModel && !form.models.includes(pendingModel)
        ? { ...form, models: [...form.models, pendingModel] }
        : form;
    const parsedHeaders = parseHeadersText(piHeadersText);
    const nextForm = updatePiSettings(withPendingModel, (pi) => {
      const nextPi = { ...pi };
      if (parsedHeaders) nextPi.headers = parsedHeaders;
      else delete nextPi.headers;
      return nextPi;
    });

    const nextErrors = validateProviderDraft(nextForm);
    setErrors(nextErrors);

    if (pendingModel) {
      setNewModel('');
      if (nextForm !== form) {
        setForm(nextForm);
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    onSave(normalizeProviderDraft(nextForm), setAsDefault);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent size="lg" className={styles.dialogContent}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className={styles.dialogBody}>
          <Field
            label="快速配置"
            hint={
              selectedPreset
                ? selectedPreset.description
                : 'Pi 已内置常见 provider；选厂商后通常只需要填写 API Key。'
            }
          >
            <Select
              value={presetId}
              options={QUICK_PROVIDER_OPTIONS}
              onChange={(e) => handlePresetChange(e.target.value)}
            />
          </Field>

          <Field label="名称" required error={errors.name}>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value, 'name')}
              placeholder="例如：本地 Ollama"
              size="sm"
              aria-invalid={Boolean(errors.name)}
            />
          </Field>

          {isQuickPreset && !isClaudeCodeAcp ? (
            <Field
              label="API Key"
              required={selectedPreset?.apiKeyRequired ?? true}
              error={errors.apiKey}
            >
              <Input
                variant="password"
                value={form.apiKey}
                onChange={(e) => {
                  set('apiKey', e.target.value, 'apiKey');
                  setModelTests({});
                }}
                placeholder={selectedPreset?.apiKeyPlaceholder ?? 'sk-...'}
                size="sm"
                aria-invalid={Boolean(errors.apiKey)}
              />
            </Field>
          ) : null}

          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setShowAdvanced((open) => !open)}
          >
            {showAdvanced ? '收起高级配置' : '展开高级配置'}
          </button>

          {showAdvanced ? (
            <>
              <Field label="类型">
                <Select
                  value={form.type}
                  options={PROVIDER_TYPE_OPTIONS}
                  onChange={(e) => {
                  const nextType = e.target.value as LLMProvider['type'];
                    setPresetId(CUSTOM_PROVIDER_PRESET_ID);
                    setForm((f) => {
                      // 切换到 LM Studio 时，base URL 留空则填默认；apiKey 留空允许保留
                      const next: LLMProvider = { ...f, type: nextType };
                      const nextPi = { ...(next.pi ?? {}) };
                      delete nextPi.builtinProviderId;
                      next.pi = Object.keys(nextPi).length > 0 ? nextPi : undefined;
                      if (nextType === 'lmstudio' && !next.baseUrl.trim()) {
                        next.baseUrl = LMSTUDIO_DEFAULT_BASE_URL;
                      }
                      if (nextType === 'minimax' && !next.baseUrl.trim()) {
                        next.baseUrl = MINIMAX_ANTHROPIC_DEFAULT_BASE_URL;
                      }
                      if (nextType === 'volcengine_ark' && !next.baseUrl.trim()) {
                        next.baseUrl = VOLCENGINE_ARK_DEFAULT_BASE_URL;
                      }
                      if (nextType === 'claude_code_acp') {
                        next.baseUrl = '';
                        next.apiKey = '';
                        if (next.models.length === 0) {
                          next.models = [CLAUDE_CODE_ACP_DEFAULT_MODEL];
                        }
                        if (!next.name.trim()) {
                          next.name = 'Claude Code ACP';
                        }
                      }
                      return next;
                    });
                    clearFieldError('baseUrl');
                    clearFieldError('apiKey');
                    clearFieldError('models');
                  }}
                />
              </Field>

              {!isClaudeCodeAcp ? (
                <>
                  <Field
                    label="Base URL"
                    required={form.type !== 'gemini' && form.type !== 'lmstudio'}
                    error={errors.baseUrl}
                    hint={
                      form.type === 'gemini'
                        ? `留空使用 Google 官方端点（${GEMINI_DEFAULT_BASE_URL}）`
                        : form.type === 'lmstudio'
                          ? `LM Studio 默认本地端点为 ${LMSTUDIO_DEFAULT_BASE_URL}`
                          : form.type === 'minimax'
                            ? `MiniMax Anthropic 兼容端点，留空用默认（${MINIMAX_ANTHROPIC_DEFAULT_BASE_URL}）`
                            : form.type === 'volcengine_ark'
                              ? `火山方舟标准 Chat 端点，留空用默认（${VOLCENGINE_ARK_DEFAULT_BASE_URL}）`
                              : undefined
                    }
                  >
                    <Input
                      value={form.baseUrl}
                      onChange={(e) => {
                        set('baseUrl', e.target.value, 'baseUrl');
                        setModelTests({});
                      }}
                      placeholder={
                        form.type === 'gemini'
                          ? GEMINI_DEFAULT_BASE_URL
                          : form.type === 'lmstudio'
                            ? LMSTUDIO_DEFAULT_BASE_URL
                            : form.type === 'minimax'
                              ? MINIMAX_ANTHROPIC_DEFAULT_BASE_URL
                              : form.type === 'volcengine_ark'
                                ? VOLCENGINE_ARK_DEFAULT_BASE_URL
                                : 'https://api.openai.com/v1'
                      }
                      size="sm"
                      aria-invalid={Boolean(errors.baseUrl)}
                    />
                  </Field>

                  {!isQuickPreset ? (
                    <Field
                      label="API Key"
                      required={form.type !== 'lmstudio'}
                      error={errors.apiKey}
                      hint={form.type === 'lmstudio' ? 'LM Studio 默认无需 API Key，可留空' : undefined}
                    >
                      <Input
                        variant="password"
                        value={form.apiKey}
                        onChange={(e) => {
                          set('apiKey', e.target.value, 'apiKey');
                          setModelTests({});
                        }}
                        placeholder={form.type === 'lmstudio' ? '可留空' : 'sk-...'}
                        size="sm"
                        aria-invalid={Boolean(errors.apiKey)}
                      />
                    </Field>
                  ) : null}
                </>
              ) : (
                <p className={styles.hintText}>
                  复用 Claude Code 设置中的认证、安装和版本配置，不需要 Base URL 或 API Key。
                </p>
              )}
            </>
          ) : null}

          <Field
            label={isQuickPreset ? '默认模型' : '模型列表'}
            required
            error={errors.models}
            hint={
              isQuickPreset
                ? '已按 Pi 内置 provider 预填常用模型；需要更多模型时可展开高级配置添加。'
                : undefined
            }
          >
            {form.models.length > 0 ? (
              <div className={styles.modelList}>
                {form.models.map((m, idx) => {
                  const testState = modelTests[m] ?? { status: 'idle' };
                  return (
                    <div key={`${m}-${idx}`} className={styles.modelItem}>
                      <Badge variant="secondary" size="xs">
                        {m}
                      </Badge>
                      <div className={styles.modelItemActions}>
                        {testState.status === 'ok' ? (
                          <span
                            className={`${styles.testResult} ${styles.testResultOk}`}
                            title="测试成功"
                          >
                            🟢 {testState.latencyMs} ms
                          </span>
                        ) : testState.status === 'error' ? (
                          <span
                            className={`${styles.testResult} ${styles.testResultError}`}
                            title={testState.message}
                          >
                            🔴 {testState.message}
                          </span>
                        ) : testState.status === 'testing' ? (
                          <span className={styles.testResult} title="正在测试">
                            测试中…
                          </span>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void handleTestModel(m);
                          }}
                          disabled={testState.status === 'testing'}
                        >
                          {testState.status === 'testing' ? '测试中…' : '测试'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={styles.removeModelButton}
                          onClick={() => removeModel(idx)}
                          disabled={!showAdvanced && isQuickPreset}
                        >
                          移除
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={styles.hintText}>暂未添加模型</p>
            )}
            {showAdvanced ? (
              <div className={styles.modelInputRow}>
                <Input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addModel();
                    }
                  }}
                  placeholder="输入模型名后按 Enter 或点击添加"
                  size="sm"
                  wrapperClassName={styles.modelInput}
                  aria-invalid={Boolean(errors.models)}
                />
                <Button type="button" variant="secondary" size="sm" onClick={addModel}>
                  添加
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void handleFetchModels();
                  }}
                  disabled={picker.status === 'loading'}
                >
                  {picker.status === 'loading' ? '拉取中…' : '拉取模型列表'}
                </Button>
              </div>
            ) : null}

            {picker.status === 'error' ? (
              <p className={styles.fetchError}>{picker.message}</p>
            ) : null}

            {picker.status === 'ready' ? (
              <div className={styles.fetchPanel}>
                <div className={styles.fetchPanelHeader}>
                  <span className={styles.hintText}>
                    共拉取到 {picker.fetched.length} 个新模型，已勾选 {picker.selected.size} 个
                  </span>
                  <div className={styles.fetchPanelActions}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAllPickerSelection(true)}
                    >
                      全选
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAllPickerSelection(false)}
                    >
                      清空
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPicker({ status: 'idle' })}
                    >
                      关闭
                    </Button>
                  </div>
                </div>
                <div className={styles.fetchOptionList}>
                  {picker.fetched.map((id) => (
                    <Checkbox
                      key={id}
                      label={id}
                      checked={picker.selected.has(id)}
                      onChange={() => togglePickerSelection(id)}
                      size="sm"
                    />
                  ))}
                </div>
                <div className={styles.fetchPanelFooter}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={applyPickerSelection}
                    disabled={picker.selected.size === 0}
                  >
                    添加选中（{picker.selected.size}）
                  </Button>
                </div>
              </div>
            ) : null}
          </Field>

          {form.models.length > 0 ? (
            <Field
              label="默认模型"
              hint="该 Provider 被设为默认、且提示词未单独绑定模型时使用；留空则用模型列表首项。"
            >
              <Select
                value={
                  form.defaultModel && form.models.includes(form.defaultModel)
                    ? form.defaultModel
                    : ''
                }
                options={[
                  { value: '', label: '自动（模型列表首项）' },
                  ...form.models.map((m) => ({ value: m, label: m })),
                ]}
                onChange={(e) => set('defaultModel', e.target.value || undefined)}
              />
            </Field>
          ) : null}

          {!isClaudeCodeAcp && !isVolcengineArk ? (
            <Field
              label="开启思考模式"
              hint={
                form.type === 'gemini'
                  ? '关闭后会向 Gemini 传入 thinkingConfig.thinkingBudget=0'
                  : form.type === 'minimax'
                    ? '关闭后走 MiniMax Anthropic 端点的 thinking.type=disabled（真正不思考、更快）'
                    : '关闭后会向兼容 OpenAI 的接口追加 enable_thinking=false（注意：MiniMax 的 OpenAI 端点会忽略该参数）'
              }
            >
              <Switch
                checked={form.enableThinking ?? true}
                onChange={(checked) => set('enableThinking', checked)}
              />
            </Field>
          ) : null}

          {form.type === 'minimax' && (form.enableThinking ?? true) ? (
            <Field
              label="思考深度（budget tokens）"
              hint="开启思考时，模型最多用于推理的 token 预算；越小越快，越大思考越深。最小 1024。"
            >
              <Input
                variant="number"
                min={1024}
                step={512}
                value={String(form.thinkingBudgetTokens ?? MINIMAX_DEFAULT_THINKING_BUDGET)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set('thinkingBudgetTokens', Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);
                }}
                size="sm"
              />
            </Field>
          ) : null}

          {isVolcengineArk ? (
            <>
              <Field
                label="深度思考模式"
                hint="映射到火山方舟请求体的 thinking.type；auto 让模型按问题难度自行决定是否思考。"
              >
                <Select
                  value={form.volcengineArk?.thinkingMode ?? 'enabled'}
                  options={ARK_THINKING_MODE_OPTIONS}
                  onChange={(e) =>
                    setArk(
                      'thinkingMode',
                      e.target.value as NonNullable<LLMProvider['volcengineArk']>['thinkingMode'],
                    )
                  }
                />
              </Field>

              <Field
                label="思考力度（reasoning_effort）"
                hint="减少思考深度可提速、省 token。留空跟随 API 默认（medium）；max 仅部分模型生效。"
              >
                <Select
                  value={form.volcengineArk?.reasoningEffort ?? ''}
                  options={ARK_REASONING_EFFORT_OPTIONS}
                  onChange={(e) =>
                    setArk(
                      'reasoningEffort',
                      (e.target.value ||
                        undefined) as NonNullable<LLMProvider['volcengineArk']>['reasoningEffort'],
                    )
                  }
                />
              </Field>

              <Field
                label="在线推理模式（service_tier）"
                hint="fast 走低延迟额度，auto 优先 TPM 保障包，default 仅用常规模式。留空跟随 API 默认（auto）。"
              >
                <Select
                  value={form.volcengineArk?.serviceTier ?? ''}
                  options={ARK_SERVICE_TIER_OPTIONS}
                  onChange={(e) =>
                    setArk(
                      'serviceTier',
                      (e.target.value ||
                        undefined) as NonNullable<LLMProvider['volcengineArk']>['serviceTier'],
                    )
                  }
                />
              </Field>
            </>
          ) : null}

          {showAdvanced && !isClaudeCodeAcp && !isQuickPreset ? (
            <div className={styles.piPanel}>
              <div className={styles.piPanelHeader}>
                <div>
                  <h3 className={styles.piPanelTitle}>Pi agent 参数</h3>
                  <p className={styles.piPanelHint}>
                    仅影响内置 pi agent 的 models.json 投影，不改变剪辑流水线当前 LLM 调用。
                  </p>
                </div>
              </div>

              <div className={styles.piGrid}>
                <Field label="Pi API">
                  <Select
                    value={form.pi?.api ?? ''}
                    options={PI_API_OPTIONS}
                    onChange={(e) => {
                      const value = e.target.value as PiProviderApi | '';
                      setForm((f) =>
                        updatePiSettings(f, (pi) => {
                          const nextPi = { ...pi };
                          if (value) nextPi.api = value;
                          else delete nextPi.api;
                          return nextPi;
                        }),
                      );
                    }}
                  />
                </Field>

                <Field label="最大输出 tokens">
                  <Input
                    variant="number"
                    min={1}
                    step={1024}
                    value={String(form.pi?.model?.maxTokens ?? DEFAULT_PI_MAX_TOKENS)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setForm((f) =>
                        updatePiModel(f, (model) => ({
                          ...model,
                          maxTokens: Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined,
                        })),
                      );
                    }}
                    size="sm"
                  />
                </Field>

                <Field label="上下文窗口 tokens">
                  <Input
                    variant="number"
                    min={1}
                    step={8192}
                    value={String(form.pi?.model?.contextWindow ?? DEFAULT_PI_CONTEXT_WINDOW)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setForm((f) =>
                        updatePiModel(f, (model) => ({
                          ...model,
                          contextWindow: Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined,
                        })),
                      );
                    }}
                    size="sm"
                  />
                </Field>

                <Field label="max tokens 字段">
                  <Select
                    value={form.pi?.compat?.maxTokensField ?? 'max_tokens'}
                    options={PI_MAX_TOKENS_FIELD_OPTIONS}
                    onChange={(e) => {
                      const value = e.target.value as 'max_tokens' | 'max_completion_tokens';
                      setForm((f) =>
                        updatePiCompat(f, (compat) => ({ ...compat, maxTokensField: value })),
                      );
                    }}
                  />
                </Field>

                <Field label="thinking 格式">
                  <Select
                    value={form.pi?.compat?.thinkingFormat ?? ''}
                    options={PI_THINKING_FORMAT_OPTIONS}
                    onChange={(e) => {
                      const value = e.target.value as PiThinkingFormat | '';
                      setForm((f) =>
                        updatePiCompat(f, (compat) => {
                          const nextCompat = { ...compat };
                          if (value) nextCompat.thinkingFormat = value;
                          else delete nextCompat.thinkingFormat;
                          return nextCompat;
                        }),
                      );
                    }}
                  />
                </Field>
              </div>

              <div className={styles.piSwitchGrid}>
                <Switch
                  checked={Boolean(form.pi?.authHeader)}
                  onChange={(checked) => {
                    setForm((f) =>
                      updatePiSettings(f, (pi) => {
                        const nextPi = { ...pi };
                        if (checked) nextPi.authHeader = true;
                        else delete nextPi.authHeader;
                        return nextPi;
                      }),
                    );
                  }}
                  label="自动添加 Authorization Bearer"
                />
                <Switch
                  checked={form.pi?.compat?.supportsDeveloperRole ?? false}
                  onChange={(checked) => {
                    setForm((f) =>
                      updatePiCompat(f, (compat) => ({
                        ...compat,
                        supportsDeveloperRole: checked,
                      })),
                    );
                  }}
                  label="支持 developer role"
                />
                <Switch
                  checked={form.pi?.compat?.supportsReasoningEffort ?? Boolean(form.enableThinking)}
                  onChange={(checked) => {
                    setForm((f) =>
                      updatePiCompat(f, (compat) => ({
                        ...compat,
                        supportsReasoningEffort: checked,
                      })),
                    );
                  }}
                  label="支持 reasoning_effort"
                />
                <Switch
                  checked={form.pi?.compat?.supportsUsageInStreaming ?? true}
                  onChange={(checked) => {
                    setForm((f) =>
                      updatePiCompat(f, (compat) => ({
                        ...compat,
                        supportsUsageInStreaming: checked,
                      })),
                    );
                  }}
                  label="流式返回 usage"
                />
                <Switch
                  checked={form.pi?.model?.input?.includes('image') ?? false}
                  onChange={(checked) => {
                    setForm((f) =>
                      updatePiModel(f, (model) => {
                        const nextModel = { ...model };
                        if (checked) nextModel.input = ['text', 'image'];
                        else delete nextModel.input;
                        return nextModel;
                      }),
                    );
                  }}
                  label="模型支持图片输入"
                />
              </div>

              <Field
                label="Pi 自定义 Headers"
                hint="每行一个 header，格式为 Header-Name: value；value 可使用 pi 支持的 $ENV_VAR 或 !command。"
              >
                <Textarea
                  value={piHeadersText}
                  onChange={(e) => setPiHeadersText(e.target.value)}
                  placeholder="x-api-key: $MY_PROXY_KEY"
                  rows={3}
                  resize="vertical"
                />
              </Field>
            </div>
          ) : null}

          <Checkbox
            label="设为默认 Provider"
            checked={setAsDefault}
            onChange={(checked) => setSetAsDefault(checked)}
            size="sm"
            className={styles.defaultCheckbox}
          />
        </DialogBody>
        <DialogFooter>
          <div className={styles.dialogFooterInner}>
            <ModalFooter
              onCancel={onCancel}
              onConfirm={handleConfirm}
              confirmLabel="保存"
              extra={
                Object.keys(errors).length > 0 ? (
                  <span className={styles.footerError}>请先补全 Provider 的必填项</span>
                ) : null
              }
            />
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────

interface Props {
  providers: LLMProvider[];
  defaultProviderId: string | null;
  onChange: (providers: LLMProvider[], defaultId: string | null) => void;
}

export function ProviderListSection({ providers, defaultProviderId, onChange }: Props) {
  const [editTarget, setEditTarget] = useState<LLMProvider | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSave = (updated: LLMProvider, setAsDefault: boolean) => {
    let next: LLMProvider[];
    if (isAdding) {
      next = [...providers, updated];
    } else {
      next = providers.map((p) => (p.id === updated.id ? updated : p));
    }
    const newDefaultId = setAsDefault ? updated.id : (defaultProviderId ?? null);
    onChange(next, newDefaultId);
    setEditTarget(null);
    setIsAdding(false);
  };

  const handleDelete = (id: string) => {
    const next = providers.filter((p) => p.id !== id);
    const newDefaultId =
      defaultProviderId === id ? (next[0]?.id ?? null) : (defaultProviderId ?? null);
    onChange(next, newDefaultId);
  };

  const handleGatewayConnected = (provider: LLMProvider) => {
    onChange([...providers, provider], provider.id);
  };

  const openAdd = () => {
    setEditTarget(emptyProvider());
    setIsAdding(true);
  };

  const openEdit = (p: LLMProvider) => {
    setEditTarget({ ...p });
    setIsAdding(false);
  };

  const closeDialog = () => {
    setEditTarget(null);
    setIsAdding(false);
  };

  return (
    <div className={styles.root}>
      {providers.length === 0 ? (
        <EmptyState
          eyebrow="Provider"
          title="暂无 Provider"
          description="点击下方按钮添加你的第一个 Provider。"
          actions={
            <div className={styles.providerActions}>
              <LingjiGatewayConnect onConnected={handleGatewayConnected} />
              <Button type="button" variant="secondary" onClick={openAdd}>
                + 添加 Provider
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className={styles.providerList}>
            {providers.map((p) => (
              <div key={p.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div className={styles.providerTitleGroup}>
                    <span className={styles.providerName}>{p.name || '未命名 Provider'}</span>
                    {p.id === defaultProviderId ? (
                      <Badge variant="info" size="xs">
                        默认
                      </Badge>
                    ) : null}
                  </div>
                  <div className={styles.providerActions}>
                    <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(p)}>
                      编辑
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(p.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>

                {p.type === 'claude_code_acp' ? (
                  <span className={styles.providerBaseUrl}>Claude Code ACP · 本机运行时</span>
                ) : p.baseUrl ? (
                  <span className={styles.providerBaseUrl}>{p.baseUrl}</span>
                ) : null}

                {p.models.length > 0 ? (
                  <div className={styles.providerModels}>
                    {p.models.map((m) => (
                      <Badge key={m} variant="secondary" size="xs">
                        {m}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className={styles.providerHint}>未配置模型</span>
                )}

                {p.pi ? (
                  <span className={styles.providerHint}>
                    Pi：{p.pi.builtinProviderId ? `内置 ${p.pi.builtinProviderId}` : (p.pi.api ?? '自动 API')}
                    {p.pi.model?.contextWindow ? ` · ${p.pi.model.contextWindow} ctx` : ''}
                    {p.pi.model?.maxTokens ? ` · ${p.pi.model.maxTokens} max` : ''}
                    {p.pi.model?.input?.includes('image') ? ' · image input' : ''}
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          <div className={styles.providerActions}>
            <LingjiGatewayConnect onConnected={handleGatewayConnected} />
            <Button
              type="button"
              variant="secondary"
              className={styles.addProviderButton}
              onClick={openAdd}
            >
              + 添加 Provider
            </Button>
          </div>
        </>
      )}

      {editTarget && (
        <ProviderDialog
          initial={editTarget}
          isDefault={isAdding ? false : editTarget.id === defaultProviderId}
          onSave={handleSave}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}
