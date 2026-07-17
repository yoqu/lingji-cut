import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAISettingsIssue } from "../lib/ai-settings";
import { generateSubtitleHighlights } from "../lib/subtitle-highlight-runner";
import { filterValidSubtitleHighlights } from "../lib/subtitle-highlights";
import { getFileNameFromPath } from "../lib/utils";
import type { SubtitleStyle } from "../types";
import { loadAISettings } from "../store/ai";
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
              background: timeline.subtitle.highlightBackgroundColor,
              color: timeline.subtitle.highlightTextColor,
              borderRadius: `${timeline.subtitle.highlightRadius}px`,
              padding: `${timeline.subtitle.highlightPaddingY}px ${timeline.subtitle.highlightPaddingX}px`,
            }}
          >
            关键词高亮
          </span>
        </div>
      </section>
    </div>
  );
}
