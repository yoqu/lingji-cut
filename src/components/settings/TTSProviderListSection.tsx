import { useState } from 'react';
import type { TTSProvider } from '../../types/ai';
import { Badge, Button, EmptyState } from '../../ui';
import { isLingjiManagedProviderId } from '../../lib/llm/lingji-gateway';
import {
  createEmptyTTSProvider,
  getTTSProviderTypeLabel,
  TTSProviderDialog,
} from './TTSProviderDialog';
import styles from './ImageProviderListSection.module.css';

interface TTSProviderListSectionProps {
  providers: TTSProvider[];
  defaultProviderId: string | null;
  onChange: (providers: TTSProvider[], defaultId: string | null) => void;
}

export function TTSProviderListSection({
  providers,
  defaultProviderId,
  onChange,
}: TTSProviderListSectionProps) {
  const [editTarget, setEditTarget] = useState<TTSProvider | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const openAdd = () => {
    setEditTarget(createEmptyTTSProvider());
    setIsAdding(true);
  };

  const closeDialog = () => {
    setEditTarget(null);
    setIsAdding(false);
  };

  const handleSave = (updated: TTSProvider, setAsDefault: boolean) => {
    const next = isAdding
      ? [...providers, updated]
      : providers.map((provider) => (provider.id === updated.id ? updated : provider));
    onChange(next, setAsDefault ? updated.id : defaultProviderId ?? next[0]?.id ?? null);
    closeDialog();
  };

  const handleDelete = (id: string) => {
    const next = providers.filter((provider) => provider.id !== id);
    onChange(next, defaultProviderId === id ? next[0]?.id ?? null : defaultProviderId);
  };

  return (
    <div className={styles.root}>
      {providers.length === 0 ? (
        <EmptyState
          eyebrow="TTS Provider"
          title="暂无 TTS Provider"
          description="添加 MiniMax 或 Xiaomi MiMo 后即可用于一键成稿语音合成。"
          actions={<Button type="button" variant="secondary" onClick={openAdd}>+ 添加 TTS Provider</Button>}
        />
      ) : (
        <>
          <div className={styles.providerList}>
            {providers.map((provider) => (
              <div key={provider.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div className={styles.providerTitleGroup}>
                    <span className={styles.providerName}>{provider.name}</span>
                    {provider.id === defaultProviderId ? <Badge variant="info" size="xs">默认</Badge> : null}
                    <span className={styles.providerTypeLabel}>
                      {getTTSProviderTypeLabel(provider.type)}
                    </span>
                  </div>
                  <div className={styles.providerActions}>
                    {isLingjiManagedProviderId(provider.id) ? (
                      <Badge variant="secondary" size="xs">服务端托管</Badge>
                    ) : (
                      <>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditTarget(provider)}>编辑</Button>
                        <Button type="button" variant="destructive" size="sm" onClick={() => handleDelete(provider.id)}>删除</Button>
                      </>
                    )}
                  </div>
                </div>
                <span className={styles.providerBaseUrl}>{provider.baseUrl}</span>
                <div className={styles.providerModels}>
                  {provider.models.map((model) => <Badge key={model} variant="secondary" size="xs">{model}</Badge>)}
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" className={styles.addProviderButton} onClick={openAdd}>+ 添加 TTS Provider</Button>
        </>
      )}

      {editTarget && (
        <TTSProviderDialog
          initial={editTarget}
          isDefault={isAdding ? false : editTarget.id === defaultProviderId}
          onSave={handleSave}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}
