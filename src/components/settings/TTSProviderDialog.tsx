import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TTSProvider, TTSProviderType } from '../../types/ai';
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
import {
  DEFAULT_MIMO_TTS_BASE_URL,
  DEFAULT_MIMO_TTS_MODEL,
  DEFAULT_MINIMAX_TTS_BASE_URL,
  DEFAULT_MINIMAX_TTS_MODEL,
} from '../../lib/tts-settings';
import styles from './ImageProviderListSection.module.css';

const TTS_PROVIDER_TYPE_OPTIONS: SelectOption[] = [
  { value: 'minimax', label: 'MiniMax T2A' },
  { value: 'xiaomi_mimo', label: 'Xiaomi MiMo' },
];

export const TTS_PROVIDER_TYPE_LABELS: Record<TTSProviderType, string> = {
  minimax: 'MiniMax T2A',
  xiaomi_mimo: 'Xiaomi MiMo',
};

export function getTTSProviderTypeLabel(type: TTSProviderType): string {
  return TTS_PROVIDER_TYPE_LABELS[type] ?? type;
}

function getDefaultBaseUrl(type: TTSProviderType): string {
  if (type === 'minimax') return DEFAULT_MINIMAX_TTS_BASE_URL;
  if (type === 'xiaomi_mimo') return DEFAULT_MIMO_TTS_BASE_URL;
  return '';
}

function getDefaultModels(type: TTSProviderType): string[] {
  if (type === 'minimax') {
    return [DEFAULT_MINIMAX_TTS_MODEL, 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'];
  }
  if (type === 'xiaomi_mimo') return [DEFAULT_MIMO_TTS_MODEL];
  return [];
}

function isDefaultBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed ||
    trimmed === DEFAULT_MINIMAX_TTS_BASE_URL ||
    trimmed === DEFAULT_MIMO_TTS_BASE_URL
  );
}

function isDefaultModelList(type: TTSProviderType, models: string[]): boolean {
  const defaults = getDefaultModels(type);
  return models.length === 0 || models.every((model) => defaults.includes(model));
}

export function createEmptyTTSProvider(): TTSProvider {
  return {
    id: `tts-provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    type: 'xiaomi_mimo',
    baseUrl: DEFAULT_MIMO_TTS_BASE_URL,
    apiKey: '',
    models: [DEFAULT_MIMO_TTS_MODEL],
  };
}

function normalizeProvider(provider: TTSProvider): TTSProvider {
  return {
    ...provider,
    name: provider.name.trim(),
    baseUrl: provider.baseUrl.trim(),
    apiKey: provider.apiKey.trim(),
    models: provider.models
      .map((model) => model.trim())
      .filter((model, index, list) => model.length > 0 && list.indexOf(model) === index),
  };
}

type ProviderErrors = Partial<Record<'name' | 'baseUrl' | 'apiKey' | 'models', string>>;

function validateProvider(provider: TTSProvider): ProviderErrors {
  const normalized = normalizeProvider(provider);
  const errors: ProviderErrors = {};
  if (!normalized.name) errors.name = '请输入生成服务名称';
  if (!normalized.baseUrl) errors.baseUrl = '请输入 Base URL';
  if (!normalized.apiKey) errors.apiKey = '请输入 API Key';
  if (normalized.models.length === 0) errors.models = '请至少添加一个模型';
  return errors;
}

interface TTSProviderDialogProps {
  initial: TTSProvider;
  isDefault: boolean;
  onSave: (provider: TTSProvider, isDefault: boolean) => void;
  onCancel: () => void;
}

export function TTSProviderDialog({
  initial,
  isDefault,
  onSave,
  onCancel,
}: TTSProviderDialogProps) {
  const [form, setForm] = useState<TTSProvider>({ ...initial });
  const [setAsDefault, setSetAsDefault] = useState(isDefault);
  const [newModel, setNewModel] = useState('');
  const [errors, setErrors] = useState<ProviderErrors>({});

  const set = <K extends keyof TTSProvider>(key: K, value: TTSProvider[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const handleTypeChange = (nextType: TTSProviderType) => {
    setForm((current) => ({
      ...current,
      type: nextType,
      baseUrl: isDefaultBaseUrl(current.baseUrl) ? getDefaultBaseUrl(nextType) : current.baseUrl,
      models: isDefaultModelList(current.type, current.models)
        ? getDefaultModels(nextType)
        : current.models,
    }));
  };

  const addModel = () => {
    const model = newModel.trim();
    if (model && !form.models.includes(model)) set('models', [...form.models, model]);
    setNewModel('');
  };

  const handleConfirm = () => {
    const pendingModel = newModel.trim();
    const nextForm =
      pendingModel && !form.models.includes(pendingModel)
        ? { ...form, models: [...form.models, pendingModel] }
        : form;
    const nextErrors = validateProvider(nextForm);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSave(normalizeProvider(nextForm), setAsDefault);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent size="lg" className={styles.dialogContent}>
        <DialogHeader>
          <DialogTitle>{initial.name ? '编辑口播生成服务' : '添加口播生成服务'}</DialogTitle>
        </DialogHeader>
        <DialogBody className={styles.dialogBody}>
          <Field label="名称" required error={errors.name}>
            <Input value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如：小米 MiMo 主账号" size="sm" />
          </Field>
          <Field label="类型">
            <Select value={form.type} options={TTS_PROVIDER_TYPE_OPTIONS} onChange={(event) => handleTypeChange(event.target.value as TTSProviderType)} />
          </Field>
          <Field label="Base URL" required error={errors.baseUrl}>
            <Input value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder={getDefaultBaseUrl(form.type) || 'https://example.com'} size="sm" />
          </Field>
          <Field label="API Key" required error={errors.apiKey}>
            <Input variant="password" value={form.apiKey} onChange={(event) => set('apiKey', event.target.value)} placeholder="sk-..." size="sm" />
          </Field>
          <Field label="模型列表" required error={errors.models}>
            <div className={styles.modelList}>
              {form.models.map((model, index) => (
                <div key={`${model}-${index}`} className={styles.modelItem}>
                  <Badge variant="secondary" size="xs">{model}</Badge>
                  <Button type="button" variant="ghost" size="sm" leftIcon={<Trash2 size={12} />} className={styles.removeModelButton} onClick={() => set('models', form.models.filter((_, itemIndex) => itemIndex !== index))}>移除</Button>
                </div>
              ))}
            </div>
            <div className={styles.modelInputRow}>
              <Input value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} placeholder="输入模型名后按 Enter 或点击添加" size="sm" wrapperClassName={styles.modelInput} />
              <Button type="button" variant="secondary" size="sm" leftIcon={<Plus size={12} />} onClick={addModel}>添加</Button>
            </div>
          </Field>
          <Checkbox label="设为默认口播生成服务" checked={setAsDefault} onChange={setSetAsDefault} size="sm" className={styles.defaultCheckbox} />
          <ModalFooter onCancel={onCancel} onConfirm={handleConfirm} confirmLabel="保存" extra={Object.keys(errors).length > 0 ? <span className={styles.footerError}>请先补全生成服务的必填项</span> : null} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
