import { useState } from 'react';
import type { ImageProvider, ImageProviderType } from '../../types/ai';
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
} from '../../ui';
import type { SelectOption } from '../../ui';
import {
  normalizeImageProviderDraft,
  validateImageProviderDraft,
} from './ai-config-utils';
import { useTaskProgressStore } from '../../store/task-progress';
import { isLingjiManagedProviderId } from '../../lib/llm/lingji-gateway';
import styles from './ImageProviderListSection.module.css';

/** 生成唯一 ID */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Capabilities 摘要（硬编码，避免拉入主进程依赖）───────────────────────

interface CapabilitiesSummary {
  ratios: string;
  maxN: number;
  isAsync: boolean;
  defaultModels: string[];
  defaultBaseUrl: string;
}

const CAPABILITIES_SUMMARY: Record<ImageProviderType, CapabilitiesSummary> = {
  jimeng: {
    ratios: '1:1 / 16:9 / 9:16 / 4:3 / 3:4',
    maxN: 4,
    isAsync: false,
    defaultModels: ['jimeng-5.0'],
    defaultBaseUrl: 'https://jimeng.jianying.com',
  },
  openai_image: {
    ratios: '1:1 / 16:9 / 9:16',
    maxN: 10,
    isAsync: false,
    defaultModels: ['gpt-image-1', 'gpt-image-2', 'dall-e-3'],
    defaultBaseUrl: 'https://api.openai.com',
  },
  minimax: {
    ratios: '1:1 / 16:9 / 9:16 / 4:3 / 3:4',
    maxN: 8,
    isAsync: false,
    defaultModels: ['image-01'],
    defaultBaseUrl: 'https://api.minimax.chat',
  },
  doubao: {
    ratios: '1:1 / 16:9 / 9:16',
    maxN: 1,
    isAsync: true,
    defaultModels: ['doubao-seedream-3.0'],
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
  },
  imagen: {
    ratios: '1:1 / 16:9 / 9:16 / 4:3 / 3:4',
    maxN: 4,
    isAsync: false,
    defaultModels: ['imagen-3.0-generate-002', 'imagen-4'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
  wanx: {
    ratios: '1:1 / 16:9 / 9:16',
    maxN: 4,
    isAsync: true,
    defaultModels: ['wanx2.1-t2i-turbo', 'wanx-v1'],
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  },
  apimart: {
    ratios: '1:1 / 16:9 / 9:16 / 4:3 / 3:4',
    maxN: 1,
    isAsync: true,
    defaultModels: ['gpt-image-2'],
    defaultBaseUrl: 'https://api.apimart.ai',
  },
  custom: {
    ratios: '取决于端点',
    maxN: 1,
    isAsync: false,
    defaultModels: [],
    defaultBaseUrl: '',
  },
};

// ─── Provider Type 选项 ───────────────────────────────────────────────────

const IMAGE_PROVIDER_TYPE_OPTIONS: SelectOption[] = [
  { value: 'jimeng', label: '即梦' },
  { value: 'openai_image', label: 'OpenAI Images' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'doubao', label: '字节豆包' },
  { value: 'imagen', label: 'Google Imagen' },
  { value: 'wanx', label: '阿里通义万相' },
  { value: 'apimart', label: 'Apimart · GPT-Image-2' },
  { value: 'custom', label: '自定义（OpenAI 兼容）' },
];

const TYPE_LABELS: Record<ImageProviderType, string> = {
  jimeng: '即梦',
  openai_image: 'OpenAI Images',
  minimax: 'MiniMax',
  doubao: '字节豆包',
  imagen: 'Google Imagen',
  wanx: '阿里通义万相',
  apimart: 'Apimart · GPT-Image-2',
  custom: '自定义（OpenAI 兼容）',
};

function getTypeLabel(type: ImageProviderType): string {
  return TYPE_LABELS[type] ?? type;
}

/** 空白 ImageProvider 表单 */
function emptyImageProvider(): ImageProvider {
  return {
    id: genId(),
    name: '',
    type: 'jimeng',
    baseUrl: '',
    apiKey: '',
    models: [],
  };
}

function getApiKeyLabel(type: ImageProviderType): string {
  return type === 'jimeng' ? 'Session ID' : 'API Key';
}

function getApiKeyPlaceholder(type: ImageProviderType): string {
  return type === 'jimeng' ? '即梦 session 凭证' : 'sk-...';
}

function getBaseUrlPlaceholder(type: ImageProviderType): string {
  return CAPABILITIES_SUMMARY[type].defaultBaseUrl || 'https://example.com/api';
}

function buildCapabilitiesSummaryText(type: ImageProviderType): string {
  const cap = CAPABILITIES_SUMMARY[type];
  const parts: string[] = [`支持 ${cap.ratios}`, `最大批量 ${cap.maxN}`];
  if (cap.isAsync) parts.push('异步任务');
  return parts.join('；');
}

// ─── 测试状态 ─────────────────────────────────────────────────────────────

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'success'; thumbnailUrl: string }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' };

// ─── 子组件：ImageProvider 编辑弹窗 ───────────────────────────────────────

interface DialogProps {
  initial: ImageProvider;
  isDefault: boolean;
  onSave: (p: ImageProvider, isDefault: boolean) => void;
  onCancel: () => void;
}

function ImageProviderDialog({ initial, isDefault, onSave, onCancel }: DialogProps) {
  const [form, setForm] = useState<ImageProvider>({ ...initial });
  const [setAsDefault, setSetAsDefault] = useState(isDefault);
  const [newModel, setNewModel] = useState('');
  const [errors, setErrors] = useState<ReturnType<typeof validateImageProviderDraft>>({});
  const title = initial.name ? '编辑图像 Provider' : '添加图像 Provider';

  const clearFieldError = (key: keyof ReturnType<typeof validateImageProviderDraft>) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const set = <K extends keyof ImageProvider>(
    key: K,
    value: ImageProvider[K],
    errorKey?: keyof ReturnType<typeof validateImageProviderDraft>,
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errorKey) {
      clearFieldError(errorKey);
    }
  };

  // type 切换时同步 models：若当前仍是原类型默认列表（或为空），跟随切换到新类型默认；
  // 若用户已自定义过模型列表，则保留其选择
  const handleTypeChange = (nextType: ImageProviderType) => {
    setForm((f) => {
      if (f.type === nextType) return f;
      const prevDefaults = CAPABILITIES_SUMMARY[f.type].defaultModels;
      const nextDefaults = CAPABILITIES_SUMMARY[nextType].defaultModels;
      const isUntouched =
        f.models.length === 0 ||
        (f.models.length === prevDefaults.length &&
          f.models.every((m, i) => m === prevDefaults[i]));
      const nextModels = isUntouched ? [...nextDefaults] : f.models;
      return { ...f, type: nextType, models: nextModels };
    });
    clearFieldError('baseUrl');
    clearFieldError('apiKey');
    clearFieldError('models');
  };

  const addModel = () => {
    const m = newModel.trim();
    if (m && !form.models.includes(m)) {
      set('models', [...form.models, m], 'models');
    }
    setNewModel('');
  };

  const removeModel = (idx: number) =>
    set(
      'models',
      form.models.filter((_, i) => i !== idx),
      'models',
    );

  const handleConfirm = () => {
    const pendingModel = newModel.trim();
    const nextForm =
      pendingModel && !form.models.includes(pendingModel)
        ? { ...form, models: [...form.models, pendingModel] }
        : form;

    const nextErrors = validateImageProviderDraft(nextForm);
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

    onSave(normalizeImageProviderDraft(nextForm), setAsDefault);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent size="lg" className={styles.dialogContent}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className={styles.dialogBody}>
          <Field label="名称" required error={errors.name}>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value, 'name')}
              placeholder="例如：即梦主账号"
              size="sm"
              aria-invalid={Boolean(errors.name)}
            />
          </Field>

          <Field label="类型">
            <Select
              value={form.type}
              options={IMAGE_PROVIDER_TYPE_OPTIONS}
              onChange={(e) => handleTypeChange(e.target.value as ImageProviderType)}
            />
            <p className={styles.capsSummaryText}>
              {buildCapabilitiesSummaryText(form.type)}
            </p>
          </Field>

          <Field label="Base URL" required error={errors.baseUrl}>
            <Input
              value={form.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value, 'baseUrl')}
              placeholder={getBaseUrlPlaceholder(form.type)}
              size="sm"
              aria-invalid={Boolean(errors.baseUrl)}
            />
          </Field>

          <Field label={getApiKeyLabel(form.type)} required error={errors.apiKey}>
            <Input
              variant="password"
              value={form.apiKey}
              onChange={(e) => set('apiKey', e.target.value, 'apiKey')}
              placeholder={getApiKeyPlaceholder(form.type)}
              size="sm"
              aria-invalid={Boolean(errors.apiKey)}
            />
          </Field>

          <Field label="模型列表" required error={errors.models}>
            {form.models.length > 0 ? (
              <div className={styles.modelList}>
                {form.models.map((m, idx) => (
                  <div key={`${m}-${idx}`} className={styles.modelItem}>
                    <Badge variant="secondary" size="xs">
                      {m}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.removeModelButton}
                      onClick={() => removeModel(idx)}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.hintText}>暂未添加模型</p>
            )}
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
            </div>
          </Field>

          <Checkbox
            label="设为默认图像 Provider"
            checked={setAsDefault}
            onChange={(checked) => setSetAsDefault(checked)}
            size="sm"
            className={styles.defaultCheckbox}
          />

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
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ─── 子组件：测试按钮 ─────────────────────────────────────────────────────

interface TestButtonProps {
  provider: ImageProvider;
}

function TestButton({ provider }: TestButtonProps) {
  const [status, setStatus] = useState<TestStatus>({ kind: 'idle' });

  const handleTest = async () => {
    // 检查 IPC 是否可用
    const api = window.electronAPI as (typeof window.electronAPI & {
      testImageProvider?: (args: { provider: ImageProvider; model: string }) => Promise<{ url?: string }>;
    });

    if (!api?.testImageProvider) {
      setStatus({ kind: 'unavailable' });
      return;
    }

    const model = provider.models[0] ?? '';
    const taskId = `test-image-provider-${provider.id}-${Date.now()}`;
    const store = useTaskProgressStore.getState();

    store.startTask({
      id: taskId,
      category: 'cover',
      label: `测试 ${provider.name || getTypeLabel(provider.type)}`,
      mode: 'indeterminate',
      progress: 0,
      phase: '连接中',
      level: 0,
      canCancel: false,
    });

    setStatus({ kind: 'running' });

    try {
      const result = await api.testImageProvider({ provider, model });
      store.completeTask(taskId);
      setStatus({ kind: 'success', thumbnailUrl: result.url ?? '' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      store.failTask(taskId, message);
      setStatus({ kind: 'error', message });
    }
  };

  return (
    <div className={styles.testButtonWrapper}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => { void handleTest(); }}
        disabled={status.kind === 'running'}
        className={styles.testButton}
      >
        {status.kind === 'running' ? '测试中…' : '测试'}
      </Button>

      {status.kind === 'unavailable' && (
        <span className={styles.testTip}>测试功能即将上线</span>
      )}
      {status.kind === 'success' && status.thumbnailUrl && (
        <img
          src={status.thumbnailUrl}
          alt="测试结果"
          className={styles.testThumbnail}
        />
      )}
      {status.kind === 'success' && !status.thumbnailUrl && (
        <span className={styles.testSuccess}>✓ 连接成功</span>
      )}
      {status.kind === 'error' && (
        <span className={styles.testError}>✗ {status.message}</span>
      )}
    </div>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────

interface Props {
  imageProviders: ImageProvider[];
  defaultImageProviderId: string | null;
  onChange: (providers: ImageProvider[], defaultId: string | null) => void;
}

export function ImageProviderListSection({
  imageProviders,
  defaultImageProviderId,
  onChange,
}: Props) {
  const [editTarget, setEditTarget] = useState<ImageProvider | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSave = (updated: ImageProvider, setAsDefault: boolean) => {
    let next: ImageProvider[];
    if (isAdding) {
      next = [...imageProviders, updated];
    } else {
      next = imageProviders.map((p) => (p.id === updated.id ? updated : p));
    }
    const newDefaultId = setAsDefault ? updated.id : (defaultImageProviderId ?? null);
    onChange(next, newDefaultId);
    setEditTarget(null);
    setIsAdding(false);
  };

  const handleDelete = (id: string) => {
    const next = imageProviders.filter((p) => p.id !== id);
    const newDefaultId =
      defaultImageProviderId === id ? (next[0]?.id ?? null) : (defaultImageProviderId ?? null);
    onChange(next, newDefaultId);
  };

  const openAdd = () => {
    setEditTarget(emptyImageProvider());
    setIsAdding(true);
  };

  const openEdit = (p: ImageProvider) => {
    setEditTarget({ ...p });
    setIsAdding(false);
  };

  const closeDialog = () => {
    setEditTarget(null);
    setIsAdding(false);
  };

  return (
    <div className={styles.root}>
      {imageProviders.length === 0 ? (
        <EmptyState
          eyebrow="Image Provider"
          title="暂无图像 Provider"
          description="点击下方按钮添加你的第一个图像 Provider。"
          actions={
            <Button type="button" variant="secondary" onClick={openAdd}>
              + 添加图像 Provider
            </Button>
          }
        />
      ) : (
        <>
          <div className={styles.providerList}>
            {imageProviders.map((p) => (
              <div key={p.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div className={styles.providerTitleGroup}>
                    <span className={styles.providerName}>{p.name || '未命名 Provider'}</span>
                    {p.id === defaultImageProviderId ? (
                      <Badge variant="info" size="xs">
                        默认
                      </Badge>
                    ) : null}
                    <span className={styles.providerTypeLabel}>
                      {getTypeLabel(p.type)}
                    </span>
                  </div>
                  <div className={styles.providerActions}>
                    <TestButton provider={p} />
                    {isLingjiManagedProviderId(p.id) ? (
                      <Badge variant="secondary" size="xs">
                        服务端托管
                      </Badge>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>

                <span className={styles.providerCapsSummary}>
                  {buildCapabilitiesSummaryText(p.type)}
                </span>

                {p.baseUrl ? <span className={styles.providerBaseUrl}>{p.baseUrl}</span> : null}

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
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            className={styles.addProviderButton}
            onClick={openAdd}
          >
            + 添加图像 Provider
          </Button>
        </>
      )}

      {editTarget && (
        <ImageProviderDialog
          initial={editTarget}
          isDefault={isAdding ? false : editTarget.id === defaultImageProviderId}
          onSave={handleSave}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}
