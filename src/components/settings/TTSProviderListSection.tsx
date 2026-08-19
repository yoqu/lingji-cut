import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { TTSProvider } from '../../types/ai';
import { Badge, Button, EmptyState } from '../../ui';
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
          eyebrow="口播生成"
          title="暂无口播生成服务"
          description="添加 MiniMax 或 Xiaomi MiMo 后即可用于自动剪辑的口播合成。"
          actions={<Button type="button" variant="secondary" leftIcon={<Plus size={14} />} onClick={openAdd}>添加口播生成服务</Button>}
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
                    <Button type="button" variant="ghost" size="sm" leftIcon={<Pencil size={12} />} onClick={() => setEditTarget(provider)}>编辑</Button>
                    <Button type="button" variant="destructive" size="sm" leftIcon={<Trash2 size={12} />} onClick={() => handleDelete(provider.id)}>删除</Button>
                  </div>
                </div>
                <span className={styles.providerBaseUrl}>{provider.baseUrl}</span>
                <div className={styles.providerModels}>
                  {provider.models.map((model) => <Badge key={model} variant="secondary" size="xs">{model}</Badge>)}
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" className={styles.addProviderButton} leftIcon={<Plus size={14} />} onClick={openAdd}>添加口播生成服务</Button>
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
