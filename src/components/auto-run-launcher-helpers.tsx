import { PillGroup } from '../ui';
import type { AutoModeModelBinding, AutoModeOption } from './script/AutoModeSection';
import type { AISettings } from '../types/ai';
import styles from './AutoRunLauncher.module.css';

export function flattenModelOptions(settings: AISettings | null): AutoModeOption[] {
  if (!settings) return [];
  return (settings.llmProviders ?? []).flatMap((provider) => (
    provider.models.map((model) => ({
      value: `${provider.id}::${model}`,
      label: `${provider.name} / ${model}`,
    }))
  ));
}

export function resolveInitialModelBinding(
  settings: AISettings | null,
  projectBinding: { providerId: string | null; model: string | null } | null | undefined,
): AutoModeModelBinding | null {
  if (projectBinding?.providerId && projectBinding.model) {
    return { providerId: projectBinding.providerId, model: projectBinding.model };
  }
  if (settings?.defaultProviderId && settings.defaultModel) {
    return { providerId: settings.defaultProviderId, model: settings.defaultModel };
  }
  return null;
}

export function ResumeProductionModePicker({
  value,
  onChange,
}: {
  value: 'auto' | 'director';
  onChange: (value: 'auto' | 'director') => void;
}) {
  return (
    <div className={styles.modePicker} role="group" aria-label="制作模式">
      <span>制作模式</span>
      <PillGroup
        wrap={false}
        value={value}
        items={[
          { value: 'auto', label: '一键成片' },
          { value: 'director', label: '导演确认' },
        ]}
        onChange={onChange}
      />
    </div>
  );
}
