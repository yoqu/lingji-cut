import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
} from '../../ui';
import { loadAISettings, useAIStore } from '../../store/ai';
import { resolvePromptBinding, PromptBindingError } from '../../lib/llm/binding-resolver';
import type { AISettings, LLMProvider, PromptBinding } from '../../types/ai';
import styles from '../script/ModelSelector.module.css';

function hasExplicitBinding(binding: PromptBinding | undefined): boolean {
  return Boolean(binding?.providerId?.trim() && binding?.model?.trim());
}

/** 发布识别模型：写入全局 `publish.metadata` 绑定，同时约束识别导演与封面提示词工具。 */
export function IngestModelSelector({ disabled = false }: { disabled?: boolean }) {
  const setGlobalBinding = useAIStore((state) => state.setGlobalBinding);
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void loadAISettings().then((settings) => {
      if (settings) setAiSettings(settings);
    });
  }, []);

  const currentBinding = aiSettings?.promptBindings?.['publish.metadata'];
  const explicit = hasExplicitBinding(currentBinding);

  const resolved = useMemo(() => {
    if (!aiSettings) return null;
    try {
      return resolvePromptBinding('publish.metadata', aiSettings, null);
    } catch (error) {
      if (error instanceof PromptBindingError) return null;
      return null;
    }
  }, [aiSettings]);

  const providers: LLMProvider[] = aiSettings?.llmProviders ?? [];
  const currentProvider = resolved?.provider ?? null;
  const currentModel = resolved?.model ?? null;

  const label = useMemo(() => {
    if (!currentProvider || !currentModel) return '未配置识别模型';
    const prefix = explicit ? '识别' : '默认';
    return `${prefix} · ${currentProvider.name} / ${currentModel}`;
  }, [currentProvider, currentModel, explicit]);

  const refresh = async () => {
    const next = await loadAISettings();
    if (next) setAiSettings(next);
  };

  const handleSelect = async (providerId: string, model: string) => {
    setOpen(false);
    await setGlobalBinding('publish.metadata', {
      providerId,
      model,
      imageProviderId: currentBinding?.imageProviderId ?? null,
      imageModel: currentBinding?.imageModel ?? null,
    });
    await refresh();
  };

  const handleReset = async () => {
    setOpen(false);
    await setGlobalBinding('publish.metadata', null);
    await refresh();
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={`${styles.trigger} ${explicit ? styles.triggerBound : ''}`.trim()}
          data-testid="ingest-model-selector"
          leftIcon={<Cpu size={12} />}
          title={explicit ? '识别使用已绑定模型，点击切换' : '识别使用全局默认模型，点击切换'}
        >
          <span className={styles.triggerLabel}>{label}</span>
          <ChevronDown className={styles.triggerArrow} size={12} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6} className={styles.menuContent}>
        <DropdownMenuLabel className={styles.headerLabel}>
          识别模型（同时用于发布文案生成）
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {providers.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title="尚未配置生成服务"
              description="请前往设置 → AI 添加生成服务后再切换识别模型。"
            />
          </div>
        ) : (
          providers.map((provider, index) => (
            <div key={provider.id}>
              <DropdownMenuLabel className={styles.groupLabel}>{provider.name}</DropdownMenuLabel>
              {(provider.models ?? []).length > 0 ? (
                (provider.models ?? []).map((model) => {
                  const isSelected = currentProvider?.id === provider.id && currentModel === model;
                  return (
                    <DropdownMenuCheckboxItem
                      key={model}
                      checked={isSelected}
                      onCheckedChange={() => void handleSelect(provider.id, model)}
                      className={styles.modelItem}
                    >
                      <span className={styles.modelName}>{model}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })
              ) : (
                <div className={styles.emptyModelRow}>该生成服务暂无模型</div>
              )}
              {index < providers.length - 1 ? <DropdownMenuSeparator /> : null}
            </div>
          ))
        )}
        {explicit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={styles.resetItem} onSelect={() => void handleReset()}>
              清除绑定，回到全局默认
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
