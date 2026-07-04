import { useCallback, useState } from 'react';
import type { TextOverlayData } from '../types';
import { useTimelineStore } from '../store/timeline';
import { TEXT_TEMPLATES } from '../lib/text-templates';
import { ENTER_PRESETS, EXIT_PRESETS, LOOP_PRESETS } from '../lib/motion-presets';
import { AppIcon, type AppIconName } from './AppIcon';
import {
  Button,
  ColorField,
  NumberField,
  Select,
  Slider,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type SelectOption,
} from '../ui';
import styles from './TextInspector.module.css';

// ── 模板描述映射 ──

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  'text-template:heading': '醒目的大号标题，适合封面',
  'text-template:subheading': '中号加粗标题，适合段落',
  'text-template:body': '左对齐正文，适合长段落',
  'text-template:caption': '半透明背景字幕条',
  'text-template:fancy': '红色描边花字效果',
};

const FONT_OPTIONS: SelectOption[] = [
  { value: 'PingFang SC', label: 'PingFang SC' },
  { value: 'Noto Sans SC', label: 'Noto Sans SC' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue' },
  { value: 'Arial', label: 'Arial' },
  { value: 'STHeiti', label: 'STHeiti' },
  { value: 'SimHei', label: 'SimHei' },
];

// ── 组件 ──

type TabKey = 'basic' | 'animation' | 'template';

interface TextInspectorProps {
  overlayId: string;
  onDelete: () => void;
}

export function TextInspector({ overlayId, onDelete }: TextInspectorProps) {
  const { timeline, updateOverlay } = useTimelineStore();
  const overlay = timeline.overlays.find((o) => o.id === overlayId);
  const textData = overlay?.textData;

  const [activeTab, setActiveTab] = useState<TabKey>('basic');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const updateTextData = useCallback(
    (updates: Partial<TextOverlayData>) => {
      if (!textData) return;
      updateOverlay(overlayId, { textData: { ...textData, ...updates } });
    },
    [overlayId, textData, updateOverlay],
  );

  if (!textData) {
    return <div className={styles.empty}>文字不存在</div>;
  }

  // ── Tab 渲染 ──

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'basic', label: '基础' },
    { key: 'animation', label: '动画' },
    { key: 'template', label: '模板' },
  ];

  return (
    <div className={styles.root}>
      {/* Tab 栏 */}
      <div className={styles.tabs}>
        {tabs.map((t) => (
          <Button
            key={t.key}
            type="button"
            variant="ghost"
            size="sm"
            className={buildToggleClass(styles.tab, activeTab === t.key)}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className={styles.tabContent}>
        {activeTab === 'basic' && (
          <BasicTab
            textData={textData}
            updateTextData={updateTextData}
            onDelete={onDelete}
          />
        )}
        {activeTab === 'animation' && (
          <AnimationTab
            textData={textData}
            updateTextData={updateTextData}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
          />
        )}
        {activeTab === 'template' && (
          <TemplateTab textData={textData} updateTextData={updateTextData} />
        )}
      </div>
    </div>
  );
}

// ── 基础 Tab ──

function BasicTab({
  textData,
  updateTextData,
  onDelete,
}: {
  textData: TextOverlayData;
  updateTextData: (u: Partial<TextOverlayData>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      {/* 内容 */}
      <section className={styles.section}>
        <label className={styles.label}>内容</label>
        <Textarea
          size="sm"
          className={styles.textarea}
          value={textData.content}
          resize="vertical"
          onChange={(event) => updateTextData({ content: event.target.value })}
          rows={3}
        />
      </section>

      {/* 字体 */}
      <section className={styles.section}>
        <label className={styles.label}>字体</label>
        <Select
          className={styles.select}
          controlClassName={styles.selectControl}
          value={textData.fontFamily}
          options={FONT_OPTIONS}
          onChange={(event) => updateTextData({ fontFamily: event.target.value })}
        />
        <div className={styles.row}>
          <NumberField
            className={styles.numberField}
            value={textData.fontSize}
            min={12}
            max={200}
            onChange={(value) => updateTextData({ fontSize: value })}
          />
          <ColorField
            className={styles.colorField}
            swatchClassName={styles.colorSwatch}
            value={textData.fontColor}
            onChange={(value) => updateTextData({ fontColor: value })}
          />
        </div>
        <div className={styles.row}>
          <div className={styles.toggleGroup}>
            <IconToggleButton
              active={textData.bold}
              title="加粗"
              iconName="bold"
              onClick={() => updateTextData({ bold: !textData.bold })}
            />
            <IconToggleButton
              active={textData.italic}
              title="斜体"
              iconName="italic"
              onClick={() => updateTextData({ italic: !textData.italic })}
            />
            <IconToggleButton
              active={textData.underline}
              title="下划线"
              iconName="underline"
              onClick={() => updateTextData({ underline: !textData.underline })}
            />
          </div>
          <div className={styles.toggleGroup}>
            <IconToggleButton
              active={textData.textAlign === 'left'}
              title="左对齐"
              iconName="align-left"
              onClick={() => updateTextData({ textAlign: 'left' })}
            />
            <IconToggleButton
              active={textData.textAlign === 'center'}
              title="居中"
              iconName="align-center"
              onClick={() => updateTextData({ textAlign: 'center' })}
            />
            <IconToggleButton
              active={textData.textAlign === 'right'}
              title="右对齐"
              iconName="align-right"
              onClick={() => updateTextData({ textAlign: 'right' })}
            />
          </div>
        </div>
      </section>

      {/* 背景 */}
      <section className={styles.section}>
        <label className={styles.label}>背景</label>
        <div className={styles.row}>
          <ColorField
            className={styles.colorField}
            swatchClassName={styles.colorSwatch}
            value={
              textData.backgroundColor === 'transparent'
                ? '#000000'
                : textData.backgroundColor
            }
            onChange={(value) => updateTextData({ backgroundColor: value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={buildToggleClass(
              styles.toggleBtn,
              textData.backgroundColor === 'transparent',
            )}
            onClick={() =>
              updateTextData({
                backgroundColor:
                  textData.backgroundColor === 'transparent'
                    ? 'rgba(0,0,0,0.5)'
                    : 'transparent',
              })
            }
          >
            {textData.backgroundColor === 'transparent' ? '透明' : '有色'}
          </Button>
        </div>
      </section>

      {/* 描边与阴影 */}
      <section className={styles.section}>
        <label className={styles.label}>描边</label>
        <div className={styles.row}>
          <ColorField
            className={styles.colorField}
            swatchClassName={styles.colorSwatch}
            value={textData.strokeColor}
            onChange={(value) => updateTextData({ strokeColor: value })}
          />
          <NumberField
            className={styles.numberField}
            value={textData.strokeWidth}
            min={0}
            max={10}
            onChange={(value) => updateTextData({ strokeWidth: value })}
          />
        </div>
        <label className={styles.label}>阴影</label>
        <div className={styles.row}>
          <ColorField
            className={styles.colorField}
            swatchClassName={styles.colorSwatch}
            value={textData.shadowColor}
            onChange={(value) => updateTextData({ shadowColor: value })}
          />
          <NumberField
            className={styles.numberField}
            value={textData.shadowBlur}
            min={0}
            max={50}
            onChange={(value) => updateTextData({ shadowBlur: value })}
          />
        </div>
        <div className={styles.row}>
          <NumberField
            className={styles.numberField}
            value={textData.shadowOffsetX}
            min={-50}
            max={50}
            onChange={(value) => updateTextData({ shadowOffsetX: value })}
          />
          <NumberField
            className={styles.numberField}
            value={textData.shadowOffsetY}
            min={-50}
            max={50}
            onChange={(value) => updateTextData({ shadowOffsetY: value })}
          />
        </div>
      </section>

      {/* 间距 */}
      <section className={styles.section}>
        <label className={styles.label}>间距</label>
        <div className={styles.sliderRow}>
          <span className={styles.sliderLabel}>字间距</span>
          <Slider
            className={styles.sliderControl}
            min={-5}
            max={20}
            step={0.5}
            value={textData.letterSpacing}
            onChange={(value) => updateTextData({ letterSpacing: value })}
          />
          <span className={styles.sliderValue}>{textData.letterSpacing}px</span>
        </div>
        <div className={styles.sliderRow}>
          <span className={styles.sliderLabel}>行间距</span>
          <Slider
            className={styles.sliderControl}
            min={1}
            max={3}
            step={0.1}
            value={textData.lineHeight}
            onChange={(value) => updateTextData({ lineHeight: value })}
          />
          <span className={styles.sliderValue}>{textData.lineHeight}</span>
        </div>
      </section>

      {/* 变换 */}
      <section className={styles.section}>
        <label className={styles.label}>变换</label>
        <div className={styles.sliderRow}>
          <span className={styles.sliderLabel}>透明度</span>
          <Slider
            className={styles.sliderControl}
            min={0}
            max={1}
            step={0.05}
            value={textData.opacity}
            onChange={(value) => updateTextData({ opacity: value })}
          />
          <span className={styles.sliderValue}>
            {Math.round(textData.opacity * 100)}%
          </span>
        </div>
        <div className={styles.sliderRow}>
          <span className={styles.sliderLabel}>旋转</span>
          <Slider
            className={styles.sliderControl}
            min={0}
            max={360}
            step={1}
            value={textData.rotation}
            onChange={(value) => updateTextData({ rotation: value })}
          />
          <span className={styles.sliderValue}>{textData.rotation}°</span>
        </div>
      </section>

      {/* 删除 */}
      <section className={styles.section}>
        <Button
          variant="destructive"
          className={styles.deleteButton}
          onClick={onDelete}
        >
          <AppIcon name="trash-2" size={14} />
          删除文字
        </Button>
      </section>
    </>
  );
}

// ── 动画 Tab ──

function AnimationTab({
  textData,
  updateTextData,
  advancedOpen,
  setAdvancedOpen,
}: {
  textData: TextOverlayData;
  updateTextData: (u: Partial<TextOverlayData>) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
}) {
  const anim = textData.animation;

  return (
    <>
      {/* 入场动画 */}
      <section className={styles.section}>
        <label className={styles.label}>入场</label>
        <div className={styles.presetGrid}>
          {ENTER_PRESETS.map((p) => (
            <Button
              key={p.value}
              type="button"
              variant="ghost"
              size="sm"
              className={buildToggleClass(styles.presetCard, anim.enter === p.value)}
              onClick={() =>
                updateTextData({
                  animation: { ...anim, enter: p.value },
                })
              }
            >
              {p.label}
            </Button>
          ))}
        </div>
      </section>

      {/* 循环动画 */}
      <section className={styles.section}>
        <label className={styles.label}>循环</label>
        <div className={styles.presetGrid}>
          {LOOP_PRESETS.map((p) => (
            <Button
              key={p.value}
              type="button"
              variant="ghost"
              size="sm"
              className={buildToggleClass(styles.presetCard, anim.loop === p.value)}
              onClick={() =>
                updateTextData({
                  animation: { ...anim, loop: p.value },
                })
              }
            >
              {p.label}
            </Button>
          ))}
        </div>
      </section>

      {/* 出场动画 */}
      <section className={styles.section}>
        <label className={styles.label}>出场</label>
        <div className={styles.presetGrid}>
          {EXIT_PRESETS.map((p) => (
            <Button
              key={p.value}
              type="button"
              variant="ghost"
              size="sm"
              className={buildToggleClass(styles.presetCard, anim.exit === p.value)}
              onClick={() =>
                updateTextData({
                  animation: { ...anim, exit: p.value },
                })
              }
            >
              {p.label}
            </Button>
          ))}
        </div>
      </section>

      {/* 高级设置 */}
      <section className={styles.section}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.advancedToggle}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          {advancedOpen
            ? <AppIcon name="chevron-down" size={14} />
            : <AppIcon name="chevron-right" size={14} />
          }
          <span>高级设置</span>
        </Button>
        {advancedOpen && (
          <div className={styles.advancedContent}>
            <div className={styles.row}>
              <span className={styles.sliderLabel}>入场时长</span>
              <NumberField
                className={styles.numberField}
                value={anim.enterDurationMs}
                min={100}
                max={3000}
                step={100}
                onChange={(value) =>
                  updateTextData({
                    animation: {
                      ...anim,
                      enterDurationMs: value,
                    },
                  })
                }
              />
              <span className={styles.sliderValue}>ms</span>
            </div>
            <div className={styles.row}>
              <span className={styles.sliderLabel}>出场时长</span>
              <NumberField
                className={styles.numberField}
                value={anim.exitDurationMs}
                min={100}
                max={3000}
                step={100}
                onChange={(value) =>
                  updateTextData({
                    animation: {
                      ...anim,
                      exitDurationMs: value,
                    },
                  })
                }
              />
              <span className={styles.sliderValue}>ms</span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

// ── 模板 Tab ──

function TemplateTab({
  textData,
  updateTextData,
}: {
  textData: TextOverlayData;
  updateTextData: (u: Partial<TextOverlayData>) => void;
}) {
  return (
    <section className={styles.section}>
      <label className={styles.label}>文字模板</label>
      <div className={styles.templateGrid}>
        {TEXT_TEMPLATES.map((tpl) => (
          <Button
            key={tpl.id}
            type="button"
            variant="ghost"
            size="sm"
            className={styles.templateCard}
            onClick={() => {
              const currentContent = textData.content;
              updateTextData({ ...tpl.textData, content: currentContent });
            }}
          >
            <span className={styles.templateName}>{tpl.name}</span>
            <span className={styles.templateDesc}>
              {TEMPLATE_DESCRIPTIONS[tpl.id] ?? ''}
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}

interface IconToggleButtonProps {
  active: boolean;
  iconName: AppIconName;
  title: string;
  onClick: () => void;
}

function IconToggleButton({
  active,
  iconName,
  title,
  onClick,
}: IconToggleButtonProps) {
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={buildToggleClass(styles.toggleBtn, active)}
          aria-label={title}
          aria-pressed={active}
          onClick={onClick}
        >
          <AppIcon name={iconName} size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function buildToggleClass(baseClassName: string, isActive: boolean): string {
  return [baseClassName, isActive ? styles.active : ''].filter(Boolean).join(' ');
}
