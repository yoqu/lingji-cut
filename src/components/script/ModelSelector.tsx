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
import { useScriptStore } from '../../store/script';
import {
  resolveUserPromptBinding,
  PromptBindingError,
} from '../../lib/llm/binding-resolver';
import { userPromptBindingKey } from '../../lib/prompts';
import type { AISettings, LLMProvider } from '../../types/ai';
import styles from './ModelSelector.module.css';

/**
 * 显示当前选中口播模板在当前项目下绑定的 LLM；点击可直接切换。
 * 切换写入 AIStore.projectBindings[userPromptBindingKey('script-template', templateId)]，
 * 立即在当前项目生效。未绑定时使用全局默认 LLM。
 */
export function ModelSelector() {
  const selectedTemplate = useScriptStore((s) => s.selectedTemplate);
  const projectBindings = useAIStore((s) => s.projectBindings);
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const setProjectBinding = useAIStore((s) => s.setProjectBinding);

  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void loadAISettings().then((settings) => {
      if (settings) setAiSettings(settings);
    });
  }, []);

  const bindingKey = useMemo(
    () => userPromptBindingKey('script-template', selectedTemplate),
    [selectedTemplate],
  );

  const currentBinding = projectBindings?.[bindingKey];
  const hasExplicitBinding = Boolean(currentBinding?.providerId && currentBinding?.model);

  const resolved = useMemo(() => {
    if (!aiSettings) return null;
    try {
      return resolveUserPromptBinding(
        'script-template',
        selectedTemplate,
        aiSettings,
        projectBindings,
      );
    } catch (err) {
      if (err instanceof PromptBindingError) return null;
      return null;
    }
  }, [aiSettings, projectBindings, selectedTemplate]);

  const providers: LLMProvider[] = aiSettings?.llmProviders ?? [];
  const currentProvider = resolved?.provider ?? null;
  const currentModel = resolved?.model ?? null;

  const label = useMemo(() => {
    if (!currentProvider || !currentModel) return '未配置模型';
    const modelShort = currentModel;
    const prefix = hasExplicitBinding ? '项目' : '全局';
    return `${prefix} · ${currentProvider.name} / ${modelShort}`;
  }, [currentProvider, currentModel, hasExplicitBinding]);

  const handleSelect = async (providerId: string, model: string) => {
    setOpen(false);
    if (!currentProjectDir) {
      // 无项目上下文：无法写入项目级绑定，给用户提示
      console.warn('[TemplateBindingChip] 无当前项目，无法写入绑定');
      return;
    }
    await setProjectBinding(bindingKey, {
      providerId,
      model,
      imageProviderId: null,
      imageModel: null,
    });
  };

  const handleResetToDefault = async () => {
    setOpen(false);
    if (!currentProjectDir) return;
    await setProjectBinding(bindingKey, null);
  };

  const triggerClassName = `${styles.trigger} ${hasExplicitBinding ? styles.triggerBound : ''}`.trim();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={triggerClassName}
          leftIcon={<Cpu size={12} />}
          title={hasExplicitBinding ? '当前模板在本项目有独立绑定，点击切换' : '使用全局默认 LLM，点击绑定到当前模板'}
        >
          <span className={styles.triggerLabel}>{label}</span>
          <ChevronDown className={styles.triggerArrow} size={12} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className={styles.menuContent}>
        <DropdownMenuLabel className={styles.headerLabel}>
          绑定到当前模板（仅在此项目生效）
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {providers.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title="尚未配置生成服务"
              description="请前往系统设置添加生成服务后再绑定模型。"
            />
          </div>
        ) : (
          providers.map((provider, index) => (
            <div key={provider.id}>
              <DropdownMenuLabel className={styles.groupLabel}>{provider.name}</DropdownMenuLabel>
              {(provider.models ?? []).length > 0 ? (
                (provider.models ?? []).map((model) => {
                  const isSelected =
                    hasExplicitBinding &&
                    currentBinding?.providerId === provider.id &&
                    currentBinding?.model === model;
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

        {hasExplicitBinding && currentProjectDir && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={styles.resetItem}
              onSelect={() => {
                void handleResetToDefault();
              }}
            >
              清除绑定，回到全局默认
            </DropdownMenuItem>
          </>
        )}

        {!currentProjectDir && (
          <>
            <DropdownMenuSeparator />
            <div className={styles.emptyModelRow}>请先打开一个项目</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
