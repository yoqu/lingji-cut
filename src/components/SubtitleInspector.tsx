import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getAISettingsIssue } from "../lib/ai-settings";
import { generateSubtitleHighlights } from "../lib/subtitle-highlight-runner";
import { filterValidSubtitleHighlights } from "../lib/subtitle-highlights";
import { getStylePresetById } from "../lib/card-style";
import {
  applySubtitlePreset,
  getSubtitlePresetById,
  resolveSubtitleStyle,
  SUBTITLE_FONT_STACK_OPTIONS,
  SUBTITLE_STYLE_PRESETS,
  type SubtitleStylePreset,
} from "../lib/subtitle-style-presets";
import { getFileNameFromPath } from "../lib/utils";
import type { SubtitleStyle } from "../types";
import { loadAISettings, useAIStore } from "../store/ai";
import { useTaskProgressStore } from "../store/task-progress";
import { useTimelineStore } from "../store/timeline";
import { Button, ColorField, NumberField, Select, Switch } from "../ui";
import { AppIcon } from "./AppIcon";
import styles from "./SubtitleInspector.module.css";

const HIGHLIGHT_ANIMATION_OPTIONS: Array<{
  value: SubtitleStyle["highlightAnimation"];
  label: string;
}> = [
  { value: "pop", label: "弹入 (pop)" },
  { value: "wipe", label: "擦入 (wipe)" },
  { value: "none", label: "无动画 (none)" },
];

const POSITION_OPTIONS: Array<{
  value: SubtitleStyle["position"];
  label: string;
}> = [
  { value: "top", label: "顶部" },
  { value: "center", label: "居中" },
  { value: "bottom", label: "底部" },
];

const ENTER_ANIMATION_OPTIONS: Array<{
  value: NonNullable<SubtitleStyle["enterAnimation"]>;
  label: string;
}> = [
  { value: "fade-rise", label: "浮入 (fade-rise)" },
  { value: "fade", label: "淡入 (fade)" },
  { value: "cut", label: "直接出现 (cut)" },
];

const HIGHLIGHT_VARIANT_OPTIONS: Array<{
  value: NonNullable<SubtitleStyle["highlightVariant"]>;
  label: string;
}> = [
  { value: "block", label: "色块" },
  { value: "text", label: "文字变色" },
];

// ColorField 的原生 color input 只接受 #rrggbb；背板色是 rgba（含透明度），
// 编辑时在 hex 与 rgba 之间互转并保留原 alpha。
const BACKDROP_RGBA_PATTERN =
  /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

function backdropColorToHex(color: string): string {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  const match = BACKDROP_RGBA_PATTERN.exec(trimmed);
  if (!match) return "#080A14";
  const channel = (value: string) => Number(value).toString(16).padStart(2, "0");
  return `#${channel(match[1])}${channel(match[2])}${channel(match[3])}`;
}

function backdropColorWithHex(hex: string, previous: string): string {
  const match = BACKDROP_RGBA_PATTERN.exec(previous.trim());
  const alpha = match?.[4] !== undefined ? Number(match[4]) : 0.52;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 预设卡片的小预览条：模拟背板/文字/高亮效果（缩放比例仅示意）。 */
function presetPreviewTextStyle(preset: SubtitleStylePreset): CSSProperties {
  const presetStyle = preset.style;
  return {
    fontFamily: presetStyle.fontFamily,
    fontWeight: presetStyle.fontWeight,
    letterSpacing: presetStyle.letterSpacing * 0.3,
    color: presetStyle.color,
    background: presetStyle.backdropEnabled ? presetStyle.backdropColor : "transparent",
    borderRadius: presetStyle.backdropEnabled ? 8 : 0,
    padding: presetStyle.backdropEnabled ? "3px 8px" : "0 2px",
    textShadow: presetStyle.backdropEnabled ? "none" : "0 1px 3px rgba(0,0,0,.6)",
  };
}

function presetPreviewHighlightStyle(preset: SubtitleStylePreset): CSSProperties {
  const presetStyle = preset.style;
  if (presetStyle.highlightVariant === "text") {
    return { color: presetStyle.highlightBackgroundColor, fontWeight: 650 };
  }
  return {
    background: presetStyle.highlightBackgroundColor,
    color: presetStyle.highlightTextColor,
    borderRadius: 3,
    padding: "0 2px",
  };
}

export function SubtitleInspector() {
  const [isGeneratingHighlights, setIsGeneratingHighlights] = useState(false);
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const [subtitleHighlightError, setSubtitleHighlightError] = useState<
    string | null
  >(null);
  const highlightInFlightRef = useRef(false);
  const highlightTask = useTaskProgressStore((state) =>
    highlightTaskId ? state.tasks.get(highlightTaskId) ?? null : null,
  );
  const {
    srtEntries,
    originalSrtEntries,
    setSubtitleHighlights,
    setSubtitleMaxChars,
    setAutoResegment,
    resegmentSubtitles,
    restoreOriginalSubtitles,
    timeline,
    updateSubtitleStyle,
  } = useTimelineStore();
  const validSubtitleHighlights = useMemo(
    () =>
      filterValidSubtitleHighlights(
        srtEntries,
        timeline.subtitleHighlights ?? [],
      ),
    [srtEntries, timeline.subtitleHighlights],
  );
  const storedSubtitleHighlightCount = timeline.subtitleHighlights?.length ?? 0;
  const expiredSubtitleHighlightCount = Math.max(
    0,
    storedSubtitleHighlightCount - validSubtitleHighlights.length,
  );

  // 字幕风格：预设骨架 + 项目视觉主题派生（与预览/导出渲染同一解析路径）。
  const projectStylePresetId = useAIStore((state) => state.projectStylePresetId);
  const subtitleTheme = useMemo(
    () => getStylePresetById(projectStylePresetId),
    [projectStylePresetId],
  );
  const previewStyle = useMemo(
    () => resolveSubtitleStyle(timeline.subtitle, subtitleTheme),
    [timeline.subtitle, subtitleTheme],
  );
  const followTheme = timeline.subtitle.followTheme ?? true;
  const backdropEnabled = timeline.subtitle.backdropEnabled ?? false;
  const activeSubtitlePresetId = getSubtitlePresetById(timeline.subtitle.presetId).id;

  const handleGenerateSubtitleHighlights = useCallback(async () => {
    if (highlightInFlightRef.current) return;
    highlightInFlightRef.current = true;
    setIsGeneratingHighlights(true);
    setSubtitleHighlightError(null);
    let taskId: string | null = null;

    try {
      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);
      if (settingsIssue || !settings) {
        setSubtitleHighlightError(settingsIssue ?? "请先完成 AI 配置");
        return;
      }
      if (srtEntries.length === 0) {
        setSubtitleHighlightError("请先导入 SRT 字幕文件");
        return;
      }

      const nextTaskId = `subtitle-highlights-${Date.now()}`;
      taskId = nextTaskId;
      setHighlightTaskId(nextTaskId);
      useTaskProgressStore.getState().startTask({
        id: nextTaskId,
        category: "ai-analyze",
        label: storedSubtitleHighlightCount > 0
          ? "重新生成关键词高亮"
          : "生成关键词高亮",
        mode: "determinate",
        progress: 0,
        phase: `准备分析 ${srtEntries.length} 条字幕`,
        level: 2,
        canCancel: false,
      });

      const highlights = await generateSubtitleHighlights(srtEntries, settings, {
        onProgress: ({ processedEntries, totalEntries, percent }) => {
          useTaskProgressStore.getState().updateTask(nextTaskId, {
            progress: percent,
            phase: processedEntries === 0
              ? `准备分析 ${totalEntries} 条字幕`
              : `生成关键词高亮 ${processedEntries}/${totalEntries}`,
          });
        },
      });
      useTaskProgressStore.getState().updateTask(nextTaskId, {
        progress: 100,
        phase: highlights.length > 0
          ? `应用 ${highlights.length} 个关键词高亮`
          : "未识别到需要高亮的关键词",
      });
      setSubtitleHighlights(highlights);
      updateSubtitleStyle({ highlightEnabled: true });
      useTaskProgressStore.getState().updateTask(nextTaskId, {
        phase: highlights.length > 0
          ? `已生成 ${highlights.length} 个关键词高亮`
          : "未识别到需要高亮的关键词",
      });
      useTaskProgressStore.getState().completeTask(nextTaskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "关键词高亮生成失败";
      const detail = message.replace(/[。！？.!?]+$/, "");
      setSubtitleHighlightError(`${detail}。请检查 AI 配置或网络后重新生成。`);
      if (taskId) useTaskProgressStore.getState().failTask(taskId, message);
    } finally {
      highlightInFlightRef.current = false;
      setIsGeneratingHighlights(false);
    }
  }, [setSubtitleHighlights, srtEntries, storedSubtitleHighlightCount, updateSubtitleStyle]);

  const handleSubtitleStyleUpdate = useCallback(
    (updates: Partial<SubtitleStyle>) => {
      setSubtitleHighlightError(null);
      updateSubtitleStyle(updates);
    },
    [updateSubtitleStyle],
  );

  // 预设即点即得：样式整体替换，仅切分设置由 applySubtitlePreset 保留。
  const handlePresetSelect = useCallback(
    (presetId: string) => {
      handleSubtitleStyleUpdate(applySubtitlePreset(presetId, timeline.subtitle));
    },
    [handleSubtitleStyleUpdate, timeline.subtitle],
  );

  const handlePositionChange = useCallback(
    (event: { target: { value: string } }) => {
      handleSubtitleStyleUpdate({
        position: event.target.value as SubtitleStyle["position"],
      });
    },
    [handleSubtitleStyleUpdate],
  );

  const handleFontFamilyChange = useCallback(
    (event: { target: { value: string } }) => {
      handleSubtitleStyleUpdate({ fontFamily: event.target.value });
    },
    [handleSubtitleStyleUpdate],
  );

  const handleEnterAnimationChange = useCallback(
    (event: { target: { value: string } }) => {
      handleSubtitleStyleUpdate({
        enterAnimation: event.target.value as SubtitleStyle["enterAnimation"],
      });
    },
    [handleSubtitleStyleUpdate],
  );

  const handleHighlightVariantChange = useCallback(
    (event: { target: { value: string } }) => {
      handleSubtitleStyleUpdate({
        highlightVariant: event.target.value as SubtitleStyle["highlightVariant"],
      });
    },
    [handleSubtitleStyleUpdate],
  );

  const srtFileName = timeline.podcast.srtPath
    ? getFileNameFromPath(timeline.podcast.srtPath)
    : "等待导入字幕";
  const validHighlightCount = validSubtitleHighlights.length;
  const highlightStatus = useMemo(() => {
    if (highlightTask?.status === "active") {
      return {
        text: highlightTask.phase ?? "准备生成关键词高亮",
        tone: "active" as const,
      };
    }

    if (highlightTask?.status === "error") {
      return { text: "关键词高亮生成失败，请重新生成", tone: "danger" as const };
    }

    if (highlightTask?.status === "completed" && highlightTask.phase) {
      return { text: highlightTask.phase, tone: "success" as const };
    }

    if (!timeline.podcast.srtPath) {
      return { text: "等待导入字幕后生成高亮", tone: "muted" as const };
    }

    if (validHighlightCount > 0) {
      return {
        text: `高亮已生成 · ${validHighlightCount} 个关键词`,
        tone: "success" as const,
      };
    }

    if (expiredSubtitleHighlightCount > 0) {
      return {
        text: `已有 ${expiredSubtitleHighlightCount} 条高亮失效，请重新生成`,
        tone: "warning" as const,
      };
    }

    return { text: "尚未生成高亮", tone: "muted" as const };
  }, [
    expiredSubtitleHighlightCount,
    highlightTask,
    timeline.podcast.srtPath,
    validHighlightCount,
  ]);

  const handleAnimationChange = useCallback(
    (event: { target: { value: string } }) => {
      handleSubtitleStyleUpdate({
        highlightAnimation: event.target.value as SubtitleStyle["highlightAnimation"],
      });
    },
    [handleSubtitleStyleUpdate],
  );

  const [sliderValue, setSliderValue] = useState(timeline.subtitle.maxCharsPerEntry);

  // 当 store 值因 undo/redo 或项目加载而外部变更时，同步本地 state
  useEffect(() => {
    setSliderValue(timeline.subtitle.maxCharsPerEntry);
  }, [timeline.subtitle.maxCharsPerEntry]);

  const maxCharsDebounceRef = useRef<number | null>(null);

  const handleMaxCharsChange = useCallback(
    (value: number) => {
      setSliderValue(value); // 立即反映到 UI，不写 store
      if (maxCharsDebounceRef.current !== null) {
        window.clearTimeout(maxCharsDebounceRef.current);
      }
      maxCharsDebounceRef.current = window.setTimeout(() => {
        setSubtitleMaxChars(value); // 防抖后单次写 store
        maxCharsDebounceRef.current = null;
      }, 300);
    },
    [setSubtitleMaxChars],
  );

  // 字号滑杆：与单条字数同一模式（本地即时反馈 + 防抖写 store，避免 undo 栈刷屏）
  const [fontSizeSliderValue, setFontSizeSliderValue] = useState(timeline.subtitle.fontSize);

  useEffect(() => {
    setFontSizeSliderValue(timeline.subtitle.fontSize);
  }, [timeline.subtitle.fontSize]);

  const fontSizeDebounceRef = useRef<number | null>(null);

  const handleFontSizeChange = useCallback(
    (value: number) => {
      setFontSizeSliderValue(value);
      if (fontSizeDebounceRef.current !== null) {
        window.clearTimeout(fontSizeDebounceRef.current);
      }
      fontSizeDebounceRef.current = window.setTimeout(() => {
        handleSubtitleStyleUpdate({ fontSize: value });
        fontSizeDebounceRef.current = null;
      }, 300);
    },
    [handleSubtitleStyleUpdate],
  );

  const handleResegmentNow = useCallback(() => {
    const { droppedHighlights } = resegmentSubtitles();
    if (droppedHighlights > 0) {
      // TODO: 接入 AppStatusBar toast 系统后显示用户可见提示
      // 目前暂用 console.warn 记录被丢弃的高亮数量
      console.warn(`[subtitle] ${droppedHighlights} 条关键词高亮因切分失效`);
    }
  }, [resegmentSubtitles]);

  const handleRestoreOriginal = useCallback(() => {
    restoreOriginalSubtitles();
  }, [restoreOriginalSubtitles]);

  useEffect(() => {
    return () => {
      if (maxCharsDebounceRef.current !== null) {
        window.clearTimeout(maxCharsDebounceRef.current);
      }
      if (fontSizeDebounceRef.current !== null) {
        window.clearTimeout(fontSizeDebounceRef.current);
      }
    };
  }, []);

  const layoutStatusText =
    originalSrtEntries.length === srtEntries.length && originalSrtEntries.length > 0
      ? `未切分（${srtEntries.length} 条）`
      : originalSrtEntries.length === 0
        ? "等待导入字幕"
        : `原 ${originalSrtEntries.length} 条 → 切分后 ${srtEntries.length} 条`;

  const isSplitApplied =
    originalSrtEntries.length > 0 && originalSrtEntries.length !== srtEntries.length;

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>字幕风格</h3>

        <div className={styles.presetGrid}>
          {SUBTITLE_STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={styles.presetCard}
              data-selected={preset.id === activeSubtitlePresetId || undefined}
              aria-pressed={preset.id === activeSubtitlePresetId}
              onClick={() => handlePresetSelect(preset.id)}
            >
              <span className={styles.presetPreview} aria-hidden="true">
                <span
                  className={styles.presetPreviewText}
                  style={presetPreviewTextStyle(preset)}
                >
                  播客字幕
                  <span style={presetPreviewHighlightStyle(preset)}>示例</span>
                </span>
              </span>
              <span className={styles.presetName}>{preset.name}</span>
            </button>
          ))}
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>跟随视觉主题</span>
          <div className={styles.rowSpacer} />
          <Switch
            checked={followTheme}
            onChange={(checked) =>
              handleSubtitleStyleUpdate({ followTheme: checked })
            }
            className={styles.switchControl}
          />
        </div>
      </section>

      <div className={styles.separator} />

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>字幕样式</h3>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>字号</span>
          <input
            type="range"
            min={24}
            max={96}
            step={1}
            value={fontSizeSliderValue}
            onChange={(event) => handleFontSizeChange(Number(event.target.value))}
            className={styles.maxCharsSlider}
            aria-label="字幕字号"
          />
          <span className={styles.maxCharsValue}>{fontSizeSliderValue}</span>
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>位置</span>
          <div className={styles.rowSpacer} />
          <Select
            value={timeline.subtitle.position}
            onChange={handlePositionChange}
            options={POSITION_OPTIONS}
            aria-label="字幕位置"
            controlClassName={styles.selectControl}
          />
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>字体</span>
          <div className={styles.rowSpacer} />
          <Select
            value={timeline.subtitle.fontFamily ?? SUBTITLE_FONT_STACK_OPTIONS[0].value}
            onChange={handleFontFamilyChange}
            options={SUBTITLE_FONT_STACK_OPTIONS}
            disabled={followTheme}
            aria-label="字幕字体"
            controlClassName={styles.selectControl}
          />
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>字重</span>
          <div className={styles.rowSpacer} />
          <NumberField
            value={timeline.subtitle.fontWeight ?? 500}
            min={300}
            max={900}
            step={50}
            onChange={(value) => handleSubtitleStyleUpdate({ fontWeight: value })}
            className={styles.numberFieldControl}
          />
        </div>

        <div className={styles.dualRow}>
          <ColorField
            label="文字颜色"
            value={timeline.subtitle.color}
            onChange={(value) => handleSubtitleStyleUpdate({ color: value })}
            showValue
            formatValue={(value) => value.toUpperCase()}
            className={styles.compactColorField}
            labelClassName={styles.fieldCaption}
          />
          <div className={styles.fieldSpacer} aria-hidden="true" />
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>背板</span>
          <div className={styles.rowSpacer} />
          <Switch
            checked={backdropEnabled}
            onChange={(checked) =>
              handleSubtitleStyleUpdate({ backdropEnabled: checked })
            }
            className={styles.switchControl}
          />
        </div>

        {backdropEnabled ? (
          <div className={styles.dualRow}>
            <ColorField
              label="背板颜色"
              value={backdropColorToHex(
                timeline.subtitle.backdropColor ?? "rgba(8,10,14,0.52)",
              )}
              onChange={(value) =>
                handleSubtitleStyleUpdate({
                  backdropColor: backdropColorWithHex(
                    value,
                    timeline.subtitle.backdropColor ?? "rgba(8,10,14,0.52)",
                  ),
                })
              }
              showValue
              formatValue={(value) => value.toUpperCase()}
              className={styles.compactColorField}
              labelClassName={styles.fieldCaption}
            />
            <div className={styles.compactNumberField}>
              <span className={styles.fieldCaption}>背板圆角 (px)</span>
              <NumberField
                value={timeline.subtitle.backdropRadius ?? 16}
                min={0}
                max={32}
                onChange={(value) =>
                  handleSubtitleStyleUpdate({ backdropRadius: value })
                }
                className={styles.numberFieldControl}
              />
            </div>
          </div>
        ) : null}

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>进场动画</span>
          <div className={styles.rowSpacer} />
          <Select
            value={timeline.subtitle.enterAnimation ?? "cut"}
            onChange={handleEnterAnimationChange}
            options={ENTER_ANIMATION_OPTIONS}
            aria-label="字幕进场动画"
            controlClassName={styles.selectControl}
          />
        </div>
      </section>

      <div className={styles.separator} />

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>字幕排版</h3>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>单条最多字数</span>
          <input
            type="range"
            min={20}
            max={60}
            step={1}
            value={sliderValue}
            onChange={(event) => handleMaxCharsChange(Number(event.target.value))}
            className={styles.maxCharsSlider}
            aria-label="单条最多字数"
          />
          <span className={styles.maxCharsValue}>{sliderValue}</span>
        </div>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>超过自动切分</span>
          <div className={styles.rowSpacer} />
          <Switch
            checked={timeline.subtitle.autoResegment}
            onChange={(checked) => setAutoResegment(checked)}
            className={styles.switchControl}
          />
        </div>

        <div className={styles.layoutActionRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleResegmentNow}
            className={styles.layoutActionButton}
          >
            立即重新切分
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRestoreOriginal}
            disabled={!isSplitApplied}
            className={styles.layoutActionButton}
          >
            还原原始字幕
          </Button>
        </div>

        <span className={styles.layoutStatusText}>{layoutStatusText}</span>
      </section>

      <div className={styles.separator} />

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>关键词高亮</h3>

        <div className={styles.statusCard}>
          <AppIcon name="file-text" size={14} className={styles.statusIcon} />
          <div className={styles.statusInfo}>
            <span className={styles.statusFile}>{srtFileName}</span>
            <span
              className={styles.statusState}
              data-tone={highlightStatus.tone}
            >
              {highlightStatus.text}
            </span>
          </div>
        </div>

        {subtitleHighlightError ? (
          <div className={styles.errorBanner} role="alert">
            {subtitleHighlightError}
          </div>
        ) : null}

        <Button
          className={styles.primaryAction}
          leftIcon={<AppIcon name="sparkles" size={12} />}
          onClick={() => void handleGenerateSubtitleHighlights()}
          disabled={!timeline.podcast.srtPath || isGeneratingHighlights}
        >
          {isGeneratingHighlights
            ? "生成中..."
            : storedSubtitleHighlightCount > 0
              ? "重新生成关键词高亮"
              : "生成关键词高亮"}
        </Button>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>启用高亮</span>
          <div className={styles.rowSpacer} />
          <Switch
            checked={timeline.subtitle.highlightEnabled}
            onChange={(checked) =>
              handleSubtitleStyleUpdate({ highlightEnabled: checked })
            }
            className={styles.switchControl}
          />
        </div>
      </section>

      <div className={styles.separator} />

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>颜色与圆角</h3>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>高亮形态</span>
          <div className={styles.rowSpacer} />
          <Select
            value={timeline.subtitle.highlightVariant ?? "block"}
            onChange={handleHighlightVariantChange}
            options={HIGHLIGHT_VARIANT_OPTIONS}
            aria-label="高亮形态"
            controlClassName={styles.selectControl}
          />
        </div>

        <div className={styles.dualRow}>
          <ColorField
            label="底色"
            value={timeline.subtitle.highlightBackgroundColor}
            onChange={(value) =>
              handleSubtitleStyleUpdate({ highlightBackgroundColor: value })
            }
            showValue
            formatValue={(value) => value.toUpperCase()}
            className={styles.compactColorField}
            labelClassName={styles.fieldCaption}
          />
          <ColorField
            label="文字"
            value={timeline.subtitle.highlightTextColor}
            onChange={(value) =>
              handleSubtitleStyleUpdate({ highlightTextColor: value })
            }
            showValue
            formatValue={(value) => value.toUpperCase()}
            className={styles.compactColorField}
            labelClassName={styles.fieldCaption}
          />
        </div>

        <div className={styles.dualRow}>
          <div className={styles.compactNumberField}>
            <span className={styles.fieldCaption}>圆角 (px)</span>
            <NumberField
              value={timeline.subtitle.highlightRadius}
              min={0}
              max={24}
              onChange={(value) => handleSubtitleStyleUpdate({ highlightRadius: value })}
              className={styles.numberFieldControl}
            />
          </div>
          <div className={styles.compactNumberField}>
            <span className={styles.fieldCaption}>横留白 (px)</span>
            <NumberField
              value={timeline.subtitle.highlightPaddingX}
              min={0}
              max={24}
              onChange={(value) => handleSubtitleStyleUpdate({ highlightPaddingX: value })}
              className={styles.numberFieldControl}
            />
          </div>
        </div>

        <div className={styles.dualRow}>
          <div className={styles.compactNumberField}>
            <span className={styles.fieldCaption}>纵留白 (px)</span>
            <NumberField
              value={timeline.subtitle.highlightPaddingY}
              min={0}
              max={16}
              onChange={(value) => handleSubtitleStyleUpdate({ highlightPaddingY: value })}
              className={styles.numberFieldControl}
            />
          </div>
          <div className={styles.fieldSpacer} aria-hidden="true" />
        </div>
      </section>

      <div className={styles.separator} />

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>动画与预览</h3>

        <div className={styles.inlineRow}>
          <span className={styles.inlineLabel}>动画效果</span>
          <div className={styles.rowSpacer} />
          <Select
            value={timeline.subtitle.highlightAnimation}
            onChange={handleAnimationChange}
            options={HIGHLIGHT_ANIMATION_OPTIONS}
            aria-label="高亮动画效果"
            controlClassName={styles.selectControl}
          />
        </div>

        <span className={styles.supportingLabel}>实时预览</span>

        <div className={styles.previewStage}>
          <span
            className={styles.previewChip}
            style={{
              fontFamily: previewStyle.fontFamily,
              fontWeight: previewStyle.fontWeight,
              letterSpacing: previewStyle.letterSpacing,
              color: previewStyle.color,
              background: previewStyle.backdropEnabled
                ? previewStyle.backdropColor
                : "transparent",
              borderRadius: previewStyle.backdropEnabled
                ? `${Math.min(previewStyle.backdropRadius ?? 16, 12)}px`
                : undefined,
              padding: previewStyle.backdropEnabled
                ? `${(previewStyle.backdropPaddingY ?? 10) * 0.5}px ${(previewStyle.backdropPaddingX ?? 22) * 0.5}px`
                : "0 2px",
              textShadow: previewStyle.backdropEnabled
                ? "none"
                : "0 1px 3px rgba(0,0,0,.5)",
            }}
          >
            示例字幕
            <span
              style={
                previewStyle.highlightVariant === "text"
                  ? {
                      color: previewStyle.highlightBackgroundColor,
                      fontWeight: 650,
                    }
                  : {
                      background: previewStyle.highlightBackgroundColor,
                      color: previewStyle.highlightTextColor,
                      borderRadius: `${Math.min(previewStyle.highlightRadius, 8)}px`,
                      padding: `${previewStyle.highlightPaddingY * 0.5}px ${previewStyle.highlightPaddingX * 0.5}px`,
                    }
              }
            >
              关键词
            </span>
          </span>
        </div>
      </section>
    </div>
  );
}
