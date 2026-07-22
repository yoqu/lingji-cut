import { useEffect, useMemo, useState } from "react";
import {
  buildDefaultExportPath,
  buildExportRenderConfig,
  EXPORT_QUALITY_OPTIONS,
  EXPORT_RESOLUTION_OPTIONS,
  extractDirFromPath,
  getLastExportQuality,
  getLastExportResolution,
  setLastExportDir,
  setLastExportQuality,
  setLastExportResolution,
  type ExportConfig,
  type ExportQuality,
  type ExportResolution,
} from "../lib/export-settings";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGrid,
  Eyebrow,
  Select,
} from "../ui";
import { AppIcon } from "./AppIcon";
import styles from "./ExportSettingsModal.module.css";

interface ExportSettingsModalProps {
  visible: boolean;
  timelineWidth: number;
  timelineHeight: number;
  projectName?: string;
  projectDir?: string;
  onClose: () => void;
  onConfirm: (payload: {
    outputPath: string;
    exportConfig: ExportConfig;
  }) => Promise<void> | void;
}

export function ExportSettingsModal({
  visible,
  timelineWidth,
  timelineHeight,
  projectName,
  projectDir,
  onClose,
  onConfirm,
}: ExportSettingsModalProps) {
  const [resolution, setResolution] = useState<ExportResolution>("720p");
  const [quality, setQuality] = useState<ExportQuality>("balanced");
  const [outputPath, setOutputPath] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pathConflict, setPathConflict] = useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }

    setResolution(getLastExportResolution() || "720p");
    setQuality(getLastExportQuality() || "balanced");
    setOutputPath(buildDefaultExportPath(projectName, projectDir));
    setIsSubmitting(false);
    setPathConflict(false);
  }, [visible, projectName, projectDir]);

  useEffect(() => {
    if (!visible || !outputPath) {
      setPathConflict(false);
      return;
    }
    const checker = window.electronAPI?.checkFileExists;
    if (typeof checker !== "function") {
      setPathConflict(false);
      return;
    }
    let cancelled = false;
    void checker(outputPath).then((exists) => {
      if (!cancelled) {
        setPathConflict(Boolean(exists));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, outputPath]);

  const renderConfig = useMemo(
    () =>
      buildExportRenderConfig({
        timelineWidth,
        timelineHeight,
        resolution,
        quality,
      }),
    [quality, resolution, timelineHeight, timelineWidth],
  );

  const summaryItems = useMemo(
    () => [
      `${renderConfig.renderWidth} × ${renderConfig.renderHeight}`,
      formatBitrateLabel(renderConfig.videoBitrate, true),
      formatBitrateLabel(renderConfig.audioBitrate, false),
      `x264 ${renderConfig.x264Preset}`,
    ],
    [renderConfig],
  );

  const handleSelectOutputPath = async () => {
    const defaultPath = outputPath || buildDefaultExportPath(projectName, projectDir);
    const savePath = await window.electronAPI.selectOutputPath(defaultPath);
    if (!savePath) {
      return;
    }

    const dir = extractDirFromPath(savePath);
    if (dir) {
      setLastExportDir(dir);
    }
    setOutputPath(savePath);
  };

  const handleConfirm = async () => {
    if (!outputPath || isSubmitting) {
      return;
    }

    if (pathConflict) {
      const confirmOverwrite = window.electronAPI?.confirmOverwrite;
      if (typeof confirmOverwrite === "function") {
        const proceed = await confirmOverwrite(outputPath);
        if (!proceed) {
          return;
        }
      }
    }

    setIsSubmitting(true);
    setLastExportResolution(resolution);
    setLastExportQuality(quality);

    try {
      await onConfirm({
        outputPath,
        exportConfig: {
          resolution,
          quality,
        },
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="full" className={styles.dialogContent}>
        <DialogHeader className={styles.header}>
          <div className={styles.headerCopy}>
            <div className={styles.eyebrowPill}>
              <Eyebrow className={styles.eyebrow}>EXPORT</Eyebrow>
            </div>
            <DialogTitle className={styles.title}>导出设置</DialogTitle>
            <DialogDescription className={styles.description}>
              配置视频导出参数
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className={styles.body}>
          <Card className={styles.pathCard}>
            <div className={styles.pathMeta}>
              <AppIcon name="folder-open" size={18} className={styles.pathIcon} />
              <div
                className={[styles.pathValue, outputPath ? styles.pathValueFilled : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                {outputPath || '还未选择导出位置'}
              </div>
            </div>
            <Button
              onClick={() => void handleSelectOutputPath()}
              variant="outline"
              size="sm"
              className={styles.pathButton}
            >
              选择位置
            </Button>
          </Card>
          {pathConflict ? (
            <div className={styles.conflictNotice} role="alert">
              <AppIcon name="alert-circle" size={14} className={styles.conflictIcon} />
              <span>该位置已存在同名文件，继续导出将覆盖原文件。</span>
            </div>
          ) : null}

          <FieldGrid className={styles.grid}>
            <Field label="分辨率">
              <Select
                value={resolution}
                options={EXPORT_RESOLUTION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                controlClassName={styles.selectControl}
                onChange={(event) => setResolution(event.target.value as ExportResolution)}
              />
            </Field>

            <Field label="导出速度">
              <Select
                value={quality}
                options={EXPORT_QUALITY_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                controlClassName={styles.selectControl}
                onChange={(event) => setQuality(event.target.value as ExportQuality)}
              />
            </Field>
          </FieldGrid>

          <Card className={styles.summaryCard}>
            <div className={styles.summary}>
              {summaryItems.map((item) => (
                <Badge key={item} variant="secondary" className={styles.summaryBadge}>
                  {item}
                </Badge>
              ))}
            </div>
          </Card>

          <div className={styles.spacer} />
        </DialogBody>
        <DialogFooter className={styles.footer}>
          <div className={styles.footerActions}>
            <Button onClick={onClose} variant="outline" className={styles.cancelButton}>
              取消
            </Button>
            <Button
              onClick={() => {
                void handleConfirm();
              }}
              variant="primary"
              className={styles.confirmButton}
              disabled={!outputPath || isSubmitting}
              loading={isSubmitting}
              loadingText="准备中..."
            >
              开始导出
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBitrateLabel(value: string, preferMbps: boolean): string {
  const numericValue = Number.parseInt(value.replace(/k$/i, ''), 10);

  if (!Number.isFinite(numericValue)) {
    return value;
  }

  if (preferMbps && numericValue >= 1000) {
    const normalized = numericValue / 1000;
    const label = Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toFixed(1);

    return `${label} Mbps`;
  }

  return `${numericValue} kbps`;
}
