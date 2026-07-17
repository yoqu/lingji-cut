import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState } from '../../ui';
import { isLingjiManagedProviderId } from '../../lib/llm/lingji-gateway';
import styles from './ImageProviderListSection.module.css';

/** 生成唯一 Provider ID */
export function genProviderId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MediaProviderBase {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

export interface MediaProviderDialogProps<T> {
  initial: T;
  isDefault: boolean;
  onSave: (p: T, isDefault: boolean) => void;
  onCancel: () => void;
}

interface Props<T extends MediaProviderBase> {
  providers: T[];
  defaultProviderId: string | null;
  onChange: (providers: T[], defaultId: string | null) => void;
  createEmptyProvider: () => T;
  getTypeLabel: (provider: T) => string;
  getCapsSummary: (provider: T) => string;
  emptyState: { eyebrow: string; title: string; description: string };
  addLabel: string;
  renderCardExtras?: (provider: T) => ReactNode;
  renderDialog: (props: MediaProviderDialogProps<T>) => ReactNode;
}

/** 图像 / 视频 Provider 通用列表区块：卡片列表 + 增删改 + 默认标记 + 编辑弹窗挂载 */
export function MediaProviderListSection<T extends MediaProviderBase>({
  providers,
  defaultProviderId,
  onChange,
  createEmptyProvider,
  getTypeLabel,
  getCapsSummary,
  emptyState,
  addLabel,
  renderCardExtras,
  renderDialog,
}: Props<T>) {
  const [editTarget, setEditTarget] = useState<T | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSave = (updated: T, setAsDefault: boolean) => {
    let next: T[];
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

  const openAdd = () => {
    setEditTarget(createEmptyProvider());
    setIsAdding(true);
  };

  const openEdit = (p: T) => {
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
          eyebrow={emptyState.eyebrow}
          title={emptyState.title}
          description={emptyState.description}
          actions={
            <Button type="button" variant="secondary" onClick={openAdd} leftIcon={<Plus size={14} />}>
              {addLabel}
            </Button>
          }
        />
      ) : (
        <>
          <div className={styles.providerList}>
            {providers.map((p) => (
              <div key={p.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div className={styles.providerTitleGroup}>
                    <span className={styles.providerName}>{p.name || '未命名生成服务'}</span>
                    {p.id === defaultProviderId ? (
                      <Badge variant="info" size="xs">
                        默认
                      </Badge>
                    ) : null}
                    <span className={styles.providerTypeLabel}>
                      {getTypeLabel(p)}
                    </span>
                  </div>
                  <div className={styles.providerActions}>
                    {renderCardExtras?.(p)}
                    {isLingjiManagedProviderId(p.id) ? (
                      <Badge variant="secondary" size="xs">
                        服务端托管
                      </Badge>
                    ) : (
                      <>
                        <Button type="button" variant="ghost" size="sm" leftIcon={<Pencil size={12} />} onClick={() => openEdit(p)}>
                          编辑
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          leftIcon={<Trash2 size={12} />}
                          onClick={() => handleDelete(p.id)}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <span className={styles.providerCapsSummary}>
                  {getCapsSummary(p)}
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
            leftIcon={<Plus size={14} />}
            onClick={openAdd}
          >
            {addLabel}
          </Button>
        </>
      )}

      {editTarget &&
        renderDialog({
          initial: editTarget,
          isDefault: isAdding ? false : editTarget.id === defaultProviderId,
          onSave: handleSave,
          onCancel: closeDialog,
        })}
    </div>
  );
}
