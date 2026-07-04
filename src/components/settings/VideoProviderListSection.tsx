import { useState } from 'react';
import type { VideoProvider, VideoProviderType } from '../../types/ai';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  ModalFooter,
  Select,
} from '../../ui';
import type { SelectOption } from '../../ui';
import { genProviderId, MediaProviderListSection } from './MediaProviderListSection';
import styles from './ImageProviderListSection.module.css';

// ─── Capabilities 摘要（硬编码概要，不依赖主进程）───────────────────────

interface CapabilitiesSummary {
  ratios: string;
  durations: string;
  defaultModels: string[];
  defaultBaseUrl: string;
}

const CAPABILITIES_SUMMARY: Record<VideoProviderType, CapabilitiesSummary> = {
  vidu: {
    ratios: '16:9 / 9:16 / 1:1',
    durations: '4s / 8s',
    defaultModels: ['vidu-2.0', 'vidu-1.5'],
    defaultBaseUrl: 'https://api.vidu.com',
  },
};

// ─── Provider Type 选项 ───────────────────────────────────────────────────

const VIDEO_PROVIDER_TYPE_OPTIONS: SelectOption[] = [
  { value: 'vidu', label: 'Vidu' },
];

const TYPE_LABELS: Record<VideoProviderType, string> = {
  vidu: 'Vidu',
};

function getTypeLabel(type: VideoProviderType): string {
  return TYPE_LABELS[type] ?? type;
}

/** 空白 VideoProvider 表单 */
function emptyVideoProvider(): VideoProvider {
  return {
    id: genProviderId(),
    name: '',
    type: 'vidu',
    baseUrl: '',
    apiKey: '',
    models: [],
  };
}

function getBaseUrlPlaceholder(type: VideoProviderType): string {
  return CAPABILITIES_SUMMARY[type].defaultBaseUrl || 'https://example.com/api';
}

function buildCapabilitiesSummaryText(type: VideoProviderType): string {
  const cap = CAPABILITIES_SUMMARY[type];
  return `比例 ${cap.ratios}；时长 ${cap.durations}`;
}

// ─── 校验 ─────────────────────────────────────────────────────────────────

interface VideoProviderDraftErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
}

function normalizeVideoProviderDraft(provider: VideoProvider): VideoProvider {
  return {
    ...provider,
    name: provider.name.trim(),
    baseUrl: provider.baseUrl.trim(),
    apiKey: provider.apiKey.trim(),
    models: provider.models
      .map((m) => m.trim())
      .filter((m, idx, list) => m.length > 0 && list.indexOf(m) === idx),
  };
}

function validateVideoProviderDraft(
  provider: VideoProvider,
): VideoProviderDraftErrors {
  const normalized = normalizeVideoProviderDraft(provider);
  const errors: VideoProviderDraftErrors = {};
  if (!normalized.name) errors.name = '请输入 Provider 名称';
  if (!normalized.baseUrl) errors.baseUrl = '请输入 Base URL';
  if (!normalized.apiKey) errors.apiKey = '请输入 API Key';
  if (normalized.models.length === 0) errors.models = '请至少添加一个模型';
  return errors;
}

// ─── 子组件：VideoProvider 编辑弹窗 ───────────────────────────────────────

interface DialogProps {
  initial: VideoProvider;
  isDefault: boolean;
  onSave: (p: VideoProvider, isDefault: boolean) => void;
  onCancel: () => void;
}

function VideoProviderDialog({ initial, isDefault, onSave, onCancel }: DialogProps) {
  const [form, setForm] = useState<VideoProvider>({ ...initial });
  const [setAsDefault, setSetAsDefault] = useState(isDefault);
  const [newModel, setNewModel] = useState('');
  const [errors, setErrors] = useState<VideoProviderDraftErrors>({});
  const title = initial.name ? '编辑视频 Provider' : '添加视频 Provider';

  const clearFieldError = (key: keyof VideoProviderDraftErrors) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const set = <K extends keyof VideoProvider>(
    key: K,
    value: VideoProvider[K],
    errorKey?: keyof VideoProviderDraftErrors,
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errorKey) clearFieldError(errorKey);
  };

  const handleTypeChange = (nextType: VideoProviderType) => {
    setForm((f) => (f.type === nextType ? f : { ...f, type: nextType }));
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

    const nextErrors = validateVideoProviderDraft(nextForm);
    setErrors(nextErrors);

    if (pendingModel) {
      setNewModel('');
      if (nextForm !== form) setForm(nextForm);
    }

    if (Object.keys(nextErrors).length > 0) return;

    onSave(normalizeVideoProviderDraft(nextForm), setAsDefault);
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
              placeholder="例如：Vidu 主账号"
              size="sm"
              aria-invalid={Boolean(errors.name)}
            />
          </Field>

          <Field label="类型">
            <Select
              value={form.type}
              options={VIDEO_PROVIDER_TYPE_OPTIONS}
              onChange={(e) => handleTypeChange(e.target.value as VideoProviderType)}
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

          <Field label="API Key" required error={errors.apiKey}>
            <Input
              variant="password"
              value={form.apiKey}
              onChange={(e) => set('apiKey', e.target.value, 'apiKey')}
              placeholder="sk-..."
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
            label="设为默认视频 Provider"
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

// ─── 主组件 ───────────────────────────────────────────────────────────────

interface Props {
  videoProviders: VideoProvider[];
  defaultVideoProviderId: string | null;
  onChange: (providers: VideoProvider[], defaultId: string | null) => void;
}

export function VideoProviderListSection({
  videoProviders,
  defaultVideoProviderId,
  onChange,
}: Props) {
  return (
    <MediaProviderListSection
      providers={videoProviders}
      defaultProviderId={defaultVideoProviderId}
      onChange={onChange}
      createEmptyProvider={emptyVideoProvider}
      getTypeLabel={(p) => getTypeLabel(p.type)}
      getCapsSummary={(p) => buildCapabilitiesSummaryText(p.type)}
      emptyState={{
        eyebrow: 'Video Provider',
        title: '暂无视频 Provider',
        description: '点击下方按钮添加你的第一个视频 Provider（Vidu / Kling / Runway 等）。',
      }}
      addLabel="+ 添加视频 Provider"
      renderDialog={(dialogProps) => <VideoProviderDialog {...dialogProps} />}
    />
  );
}
