import { useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { TTSProvider, TTSVoicePreset } from '../../types/ai';
import {
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
  Slider,
} from '../../ui';
import type { SelectOption } from '../../ui';
import styles from './ImageProviderListSection.module.css';

export function createDefaultTTSVoice(providers: TTSProvider[]): TTSVoicePreset {
  const provider = providers[0];
  const now = Date.now();
  return {
    id: `tts-voice-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    providerId: provider?.id ?? '',
    providerType: provider?.type ?? 'xiaomi_mimo',
    model: provider?.models[0] ?? null,
    voiceId: provider?.type === 'minimax' ? 'male-qn-qingse' : undefined,
    source: provider?.type === 'xiaomi_mimo' ? 'cloned' : 'system',
    params: { speed: 1, vol: 1, pitch: 0, emotion: '' },
    createdAt: now,
    updatedAt: now,
  };
}

function getAudioMime(filePath: string): 'audio/mpeg' | 'audio/wav' | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return undefined;
}

function normalizeVoice(voice: TTSVoicePreset, providers: TTSProvider[]): TTSVoicePreset {
  const provider = providers.find((item) => item.id === voice.providerId);
  const source = provider?.type === 'xiaomi_mimo' ? 'cloned' : 'system';
  const referenceAudioPath = voice.referenceAudioPath?.trim() || undefined;
  return {
    ...voice,
    name: voice.name.trim(),
    providerType: provider?.type ?? voice.providerType,
    model: voice.model?.trim() || provider?.models[0] || null,
    voiceId: source === 'system' ? voice.voiceId?.trim() || undefined : undefined,
    source,
    referenceAudioPath: source === 'cloned' ? referenceAudioPath : undefined,
    referenceAudioName:
      source === 'cloned' && referenceAudioPath ? referenceAudioPath.split(/[\\/]/).pop() : undefined,
    referenceAudioMime:
      source === 'cloned' && referenceAudioPath ? getAudioMime(referenceAudioPath) : undefined,
    params: {
      speed: voice.params.speed,
      vol: voice.params.vol ?? 1,
      pitch: voice.params.pitch ?? 0,
      emotion: voice.params.emotion ?? '',
    },
    updatedAt: Date.now(),
  };
}

type VoiceErrors = Partial<Record<'name' | 'providerId' | 'voiceId' | 'referenceAudioPath' | 'model', string>>;

function validateVoice(voice: TTSVoicePreset): VoiceErrors {
  const errors: VoiceErrors = {};
  if (!voice.name.trim()) errors.name = '请输入音色名称';
  if (!voice.providerId) errors.providerId = '请选择口播生成服务';
  if (!voice.model?.trim()) errors.model = '请选择或输入模型';
  if (voice.source === 'system' && !voice.voiceId?.trim()) errors.voiceId = '请输入音色 ID';
  if (voice.source === 'cloned') {
    if (!voice.referenceAudioPath?.trim()) errors.referenceAudioPath = '请选择或填写参考音频路径';
    else if (!getAudioMime(voice.referenceAudioPath)) errors.referenceAudioPath = '参考音频仅支持 mp3 或 wav';
  }
  return errors;
}

interface TTSVoiceDialogProps {
  initial: TTSVoicePreset;
  providers: TTSProvider[];
  isDefault: boolean;
  onSave: (voice: TTSVoicePreset, isDefault: boolean) => void;
  onCancel: () => void;
}

export function TTSVoiceDialog({
  initial,
  providers,
  isDefault,
  onSave,
  onCancel,
}: TTSVoiceDialogProps) {
  const [form, setForm] = useState<TTSVoicePreset>({ ...initial });
  const [setAsDefault, setSetAsDefault] = useState(isDefault);
  const [errors, setErrors] = useState<VoiceErrors>({});
  const selectedProvider = providers.find((provider) => provider.id === form.providerId);
  const providerOptions = useMemo<SelectOption[]>(
    () => providers.map((provider) => ({ value: provider.id, label: provider.name })),
    [providers],
  );
  const modelOptions = useMemo<SelectOption[]>(
    () => (selectedProvider?.models ?? []).map((model) => ({ value: model, label: model })),
    [selectedProvider],
  );

  const set = <K extends keyof TTSVoicePreset>(key: K, value: TTSVoicePreset[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleProviderChange = (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    setForm((current) => ({
      ...current,
      providerId,
      providerType: provider?.type ?? current.providerType,
      model: provider?.models[0] ?? current.model,
      voiceId: provider?.type === 'xiaomi_mimo' ? undefined : current.voiceId ?? 'male-qn-qingse',
      source: provider?.type === 'xiaomi_mimo' ? 'cloned' : 'system',
    }));
  };

  const handlePickAudio = async () => {
    const selected = await window.electronAPI?.selectMediaFile?.('audio');
    if (!selected) return;
    setForm((current) => ({
      ...current,
      referenceAudioPath: selected,
      referenceAudioName: selected.split(/[\\/]/).pop(),
      referenceAudioMime: getAudioMime(selected),
    }));
  };

  const handleConfirm = () => {
    const normalized = normalizeVoice(form, providers);
    const nextErrors = validateVoice(normalized);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSave(normalized, setAsDefault);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent size="lg" className={styles.dialogContent}>
        <DialogHeader><DialogTitle>{initial.name ? '编辑音色' : '添加音色'}</DialogTitle></DialogHeader>
        <DialogBody className={styles.dialogBody}>
          <Field label="音色名称" required error={errors.name}>
            <Input value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如：MiMo 宣传片旁白" size="sm" />
          </Field>
          <Field label="口播生成服务" required error={errors.providerId}>
            <Select value={form.providerId} options={providerOptions} onChange={(event) => handleProviderChange(event.target.value)} />
          </Field>
          <Field label="模型" required error={errors.model}>
            <Select value={form.model ?? ''} options={modelOptions} allowCustomValue onChange={(event) => set('model', event.target.value)} />
          </Field>
          <Field label="来源">
            <Select
              value={selectedProvider?.type === 'xiaomi_mimo' ? 'cloned' : 'system'}
              options={
                selectedProvider?.type === 'xiaomi_mimo'
                  ? [{ value: 'cloned', label: '克隆音色' }]
                  : [{ value: 'system', label: '系统音色 ID' }]
              }
              disabled
            />
          </Field>
          {form.source === 'system' ? (
            <Field label="音色 ID" required error={errors.voiceId}>
              <Input value={form.voiceId ?? ''} onChange={(event) => set('voiceId', event.target.value)} placeholder="例如：male-qn-qingse" size="sm" />
            </Field>
          ) : (
            <Field label="参考音频" required error={errors.referenceAudioPath}>
              <div className={styles.modelInputRow}>
                <Input value={form.referenceAudioPath ?? ''} onChange={(event) => set('referenceAudioPath', event.target.value)} placeholder="/Users/you/voice.mp3" size="sm" wrapperClassName={styles.modelInput} />
                <Button type="button" variant="secondary" size="sm" leftIcon={<FolderOpen size={12} />} onClick={() => { void handlePickAudio(); }}>选择</Button>
              </div>
            </Field>
          )}
          <Field label={`语速：${form.params.speed.toFixed(1)}x`}>
            <Slider min={0.5} max={2} step={0.1} value={form.params.speed} onChange={(value) => set('params', { ...form.params, speed: value })} size="md" />
          </Field>
          <Field label={`音量：${(form.params.vol ?? 1).toFixed(1)}`}>
            <Slider min={0.1} max={10} step={0.1} value={form.params.vol ?? 1} onChange={(value) => set('params', { ...form.params, vol: value })} size="md" />
          </Field>
          <Field label={`音调：${form.params.pitch && form.params.pitch > 0 ? '+' : ''}${form.params.pitch ?? 0}`}>
            <Slider min={-12} max={12} step={1} value={form.params.pitch ?? 0} onChange={(value) => set('params', { ...form.params, pitch: value })} size="md" />
          </Field>
          <Checkbox label="设为默认音色" checked={setAsDefault} onChange={setSetAsDefault} size="sm" className={styles.defaultCheckbox} />
          <ModalFooter onCancel={onCancel} onConfirm={handleConfirm} confirmLabel="保存" extra={Object.keys(errors).length > 0 ? <span className={styles.footerError}>请先补全音色的必填项</span> : null} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
