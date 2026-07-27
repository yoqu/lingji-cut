import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { Sparkles } from 'lucide-react';
import type { AutoWorkflowParams } from '../../store/ai';
import { Checkbox, Field, PillGroup, Select } from '../../ui';

export interface AutoModeOption {
  value: string;
  label: string;
}

/** 写稿模型绑定：与 projectBindings 中的 PromptBinding 保持一致 */
export interface AutoModeModelBinding {
  providerId: string;
  model: string;
}

export type AutoModeSectionMode = 'toggle' | 'always';

export interface AutoModeSectionProps {
  /** 'toggle'：渲染启用勾选框；'always'：始终展开字段（如 AutoRunLauncher 弹窗内使用） */
  mode?: AutoModeSectionMode;

  /** mode='toggle' 时必传 */
  enabled?: boolean;
  onToggle?: (next: boolean) => void;

  params: AutoWorkflowParams;
  onChangeParams: (next: AutoWorkflowParams) => void;

  /** 写稿角色列表：由 getAllRoles() 派生，已合并内置模板 + 用户自定义角色 */
  roleOptions: AutoModeOption[];
  voiceOptions: AutoModeOption[];

  /**
   * 写稿模型选项。非空时在 UI 中渲染「写稿模型」下拉；
   * 空数组时不渲染（保留对"仅角色/音色"的旧调用方向后兼容）。
   */
  modelOptions?: AutoModeOption[];
  modelBinding?: AutoModeModelBinding | null;
  onChangeModelBinding?: (next: AutoModeModelBinding | null) => void;
  /** 写稿模型字段的 hint 文案 */
  modelHint?: string;

  /**
   * Motion Card 动效模式（绑定 AISettings.motionCardMode，与系统设置里
   * 「提示词配置 → Motion Card 出卡模式」是同一个字段）。
   * 提供 onChangeMotionCardMode 时才渲染该选择器；不传则保持旧调用方 UI 不变。
   */
  motionCardMode?: 'template' | 'agent' | 'hybrid';
  onChangeMotionCardMode?: (next: 'template' | 'agent' | 'hybrid') => void;
}

function encodeBinding(binding: AutoModeModelBinding | null | undefined): string {
  return binding ? `${binding.providerId}::${binding.model}` : '';
}

function decodeBinding(value: string): AutoModeModelBinding | null {
  const idx = value.indexOf('::');
  if (idx <= 0) return null;
  return { providerId: value.slice(0, idx), model: value.slice(idx + 2) };
}

export function AutoModeSection({
  mode = 'toggle',
  enabled = false,
  onToggle,
  params,
  onChangeParams,
  roleOptions,
  voiceOptions,
  modelOptions,
  modelBinding,
  onChangeModelBinding,
  modelHint,
  motionCardMode,
  onChangeMotionCardMode,
}: AutoModeSectionProps) {
  const expanded = mode === 'always' ? true : enabled;
  const showModelField = Array.isArray(modelOptions) && modelOptions.length > 0;

  const update = (patch: Partial<AutoWorkflowParams>) => {
    onChangeParams({ ...params, ...patch });
  };

  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
    padding: mode === 'always' ? '0' : 'var(--space-4)',
    borderRadius: mode === 'always' ? '0' : 'var(--radius-md, 10px)',
    border:
      mode === 'always'
        ? 'none'
        : expanded
          ? '1px solid var(--color-system-blue)'
          : '1px solid var(--color-separator, rgba(0,0,0,0.1))',
    background:
      mode === 'always'
        ? 'transparent'
        : expanded
          ? 'color-mix(in srgb, var(--color-system-blue) 6%, var(--color-fill-secondary, transparent))'
          : 'var(--color-fill-secondary, transparent)',
    cursor: mode === 'always' ? 'default' : 'pointer',
    transition: 'background 150ms ease, border-color 150ms ease',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
  };

  const titleStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-label-primary)',
  };

  const hintStyle: CSSProperties = {
    fontSize: 12,
    color: 'var(--color-label-secondary)',
    marginLeft: 24,
  };

  const handleCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (mode === 'always' || !onToggle) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, select, button, [role="combobox"], [role="listbox"]')) return;
    onToggle(!enabled);
  };

  return (
    <div
      role="group"
      aria-label="自动剪辑"
      style={cardStyle}
      onClick={handleCardClick}
    >
      {mode === 'toggle' ? (
        <>
          <div style={headerStyle}>
            <Checkbox
              checked={enabled}
              onChange={(next) => onToggle?.(next)}
              aria-label="启用自动剪辑"
            />
            <span style={titleStyle}>
              <Sparkles size={14} strokeWidth={1.75} color="var(--color-system-blue)" />
              自动剪辑
            </span>
          </div>
          <div style={hintStyle}>
            勾选后将自动完成：生成口播稿 → 合成口播 → 生成画面 → 生成封面，并跳过审稿环节。
          </div>
        </>
      ) : null}

      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            marginTop: mode === 'toggle' ? 'var(--space-1)' : 0,
          }}
        >
          {showModelField ? (
            <Field label="写稿模型" hint={modelHint ?? '作为本项目当前模板的默认写稿模型。'}>
              <Select
                aria-label="写稿模型"
                value={encodeBinding(modelBinding)}
                options={modelOptions}
                onChange={(e) => onChangeModelBinding?.(decodeBinding(e.target.value))}
                placeholder="选择写稿模型"
              />
            </Field>
          ) : null}
          <Field label="制作模式">
            <PillGroup
              fullWidth
              wrap={false}
              value={params.productionMode ?? 'auto'}
              items={[
                { value: 'auto', label: '一键成片' },
                { value: 'director', label: '导演确认' },
              ]}
              onChange={(productionMode) => update({ productionMode })}
            />
          </Field>
          {onChangeMotionCardMode ? (
            <Field
              label="动效模式"
              hint="模板编译最快最省（推荐）；混合仅对重点段落走 Agent 精雕，每期精雕段数有上限；Agent 多轮视觉自由度更高但更慢更贵。对单卡的精雕修改始终走 Agent。"
            >
              <Select
                aria-label="动效模式"
                value={motionCardMode ?? 'template'}
                options={[
                  { value: 'template', label: '模板编译（推荐，省 token）' },
                  { value: 'hybrid', label: '混合：重点段落精雕' },
                  { value: 'agent', label: 'Agent 多轮雕刻（旧链路）' },
                ]}
                onChange={(e) =>
                  onChangeMotionCardMode(e.target.value as 'template' | 'agent' | 'hybrid')
                }
              />
            </Field>
          ) : null}
          <div style={headerStyle}>
            <Checkbox
              checked={params.bgmEnabled !== false}
              onChange={(bgmEnabled) => update({ bgmEnabled })}
              aria-label="生成背景音乐"
            />
            <span style={{ fontSize: 13, color: 'var(--color-label-primary)' }}>生成背景音乐</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--space-4)',
            }}
          >
            <Field label="写稿角色" hint="等同写稿工作台的角色选项（含内置模板与自定义角色）">
              <Select
                aria-label="写稿角色"
                value={params.roleId}
                options={roleOptions}
                onChange={(e) => update({ roleId: e.target.value })}
              />
            </Field>
            <Field label="口播音色" hint="可从列表选择，也可输入已配置的音色 ID">
              <Select
                aria-label="口播音色"
                value={params.voiceId}
                options={voiceOptions}
                onChange={(e) => update({ voiceId: e.target.value })}
                allowCustomValue
                placeholder="选择或输入音色 ID"
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}
