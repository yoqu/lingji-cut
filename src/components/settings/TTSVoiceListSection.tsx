import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { TTSProvider, TTSVoicePreset } from '../../types/ai';
import { Badge, Button, EmptyState } from '../../ui';
import { createDefaultTTSVoice, TTSVoiceDialog } from './TTSVoiceDialog';
import styles from './ImageProviderListSection.module.css';

interface TTSVoiceListSectionProps {
  voices: TTSVoicePreset[];
  providers: TTSProvider[];
  defaultVoiceId: string | null;
  onChange: (voices: TTSVoicePreset[], defaultVoiceId: string | null) => void;
}

export function TTSVoiceListSection({
  voices,
  providers,
  defaultVoiceId,
  onChange,
}: TTSVoiceListSectionProps) {
  const [editTarget, setEditTarget] = useState<TTSVoicePreset | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const openAdd = () => {
    setEditTarget(createDefaultTTSVoice(providers));
    setIsAdding(true);
  };

  const closeDialog = () => {
    setEditTarget(null);
    setIsAdding(false);
  };

  const handleSave = (updated: TTSVoicePreset, setAsDefault: boolean) => {
    const next = isAdding
      ? [...voices, updated]
      : voices.map((voice) => (voice.id === updated.id ? updated : voice));
    onChange(next, setAsDefault ? updated.id : defaultVoiceId ?? next[0]?.id ?? null);
    closeDialog();
  };

  const handleDelete = (id: string) => {
    const next = voices.filter((voice) => voice.id !== id);
    onChange(next, defaultVoiceId === id ? next[0]?.id ?? null : defaultVoiceId);
  };

  return (
    <div className={styles.root}>
      {voices.length === 0 ? (
        <EmptyState
          eyebrow="Voice"
          title="暂无音色"
          description="添加系统音色或克隆音色后即可作为默认口播音色。"
          actions={<Button type="button" variant="secondary" leftIcon={<Plus size={14} />} onClick={openAdd} disabled={providers.length === 0}>添加音色</Button>}
        />
      ) : (
        <>
          <div className={styles.providerList}>
            {voices.map((voice) => {
              const provider = providers.find((item) => item.id === voice.providerId);
              return (
                <div key={voice.id} className={styles.providerCard}>
                  <div className={styles.providerHeader}>
                    <div className={styles.providerTitleGroup}>
                      <span className={styles.providerName}>{voice.name}</span>
                      {voice.id === defaultVoiceId ? <Badge variant="info" size="xs">默认</Badge> : null}
                      <Badge variant="secondary" size="xs">{voice.source === 'cloned' ? '克隆' : '系统'}</Badge>
                    </div>
                    <div className={styles.providerActions}>
                      <Button type="button" variant="ghost" size="sm" leftIcon={<Pencil size={12} />} onClick={() => setEditTarget(voice)}>编辑</Button>
                      <Button type="button" variant="destructive" size="sm" leftIcon={<Trash2 size={12} />} onClick={() => handleDelete(voice.id)}>删除</Button>
                    </div>
                  </div>
                  <span className={styles.providerCapsSummary}>
                    {provider?.name ?? '未知生成服务'} · {voice.model ?? '未配置模型'}
                  </span>
                  <span className={styles.providerBaseUrl}>
                    {voice.source === 'cloned' ? voice.referenceAudioPath : voice.voiceId}
                  </span>
                </div>
              );
            })}
          </div>
          <Button type="button" variant="secondary" className={styles.addProviderButton} leftIcon={<Plus size={14} />} onClick={openAdd} disabled={providers.length === 0}>添加音色</Button>
        </>
      )}

      {editTarget && (
        <TTSVoiceDialog
          initial={editTarget}
          providers={providers}
          isDefault={isAdding ? false : editTarget.id === defaultVoiceId}
          onSave={handleSave}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}
