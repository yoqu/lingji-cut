import { useCallback } from 'react';
import { getFileNameFromPath } from '../lib/utils';
import { ENTER_PRESETS, EXIT_PRESETS, LOOP_PRESETS } from '../lib/motion-presets';
import { useTimelineStore } from '../store/timeline';
import type { OverlayMotion } from '../types';
import { Button, NumberField, Select, type SelectOption } from '../ui';
import { AudioInspector } from './AudioInspector';
import { TextInspector } from './TextInspector';
import styles from './OverlayInspector.module.css';

// 与 TextInspector 共用同一套动效预设与中文标签（媒体 overlay 不支持 typewriter 循环）。
const ENTER_SELECT_OPTIONS: SelectOption[] = ENTER_PRESETS.map(({ value, label }) => ({
  value,
  label,
}));
const EXIT_SELECT_OPTIONS: SelectOption[] = EXIT_PRESETS.map(({ value, label }) => ({
  value,
  label,
}));
const LOOP_SELECT_OPTIONS: SelectOption[] = LOOP_PRESETS.filter(
  ({ value }) => value !== 'typewriter',
).map(({ value, label }) => ({ value, label }));

interface OverlayInspectorProps {
  overlayId: string;
  onDelete: () => void;
}

export function OverlayInspector({ overlayId, onDelete }: OverlayInspectorProps) {
  const timeline = useTimelineStore((state) => state.timeline);
  const updateOverlay = useTimelineStore((state) => state.updateOverlay);
  const overlay = timeline.overlays.find((item) => item.id === overlayId);

  const updateMotion = useCallback(
    (updates: Partial<OverlayMotion>) => {
      if (!overlay?.motion) {
        return;
      }

      updateOverlay(overlayId, {
        motion: {
          ...overlay.motion,
          ...updates,
        },
      });
    },
    [overlay, overlayId, updateOverlay],
  );

  if (!overlay) {
    return <div className={styles.empty}>图层不存在</div>;
  }

  if (overlay.type === 'text') {
    return <TextInspector overlayId={overlayId} onDelete={onDelete} />;
  }

  if (overlay.type === 'audio') {
    return <AudioInspector overlayId={overlayId} onDelete={onDelete} />;
  }

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>基础</div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.label}>类型</span>
            <span className={styles.value}>{overlay.type === 'video' ? '视频' : '图片'}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>轨道</span>
            <span className={styles.value}>{overlay.trackId}</span>
          </div>
          <div className={[styles.field, styles.fieldWide].join(' ')}>
            <span className={styles.label}>素材</span>
            <span className={styles.value}>{getFileNameFromPath(overlay.assetPath)}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>开始时间</span>
            <span className={styles.value}>{overlay.startMs} ms</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>时长</span>
            <span className={styles.value}>{overlay.durationMs} ms</span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>动画</div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.label}>入场</span>
            <Select
              className={styles.select}
              controlClassName={styles.selectControl}
              value={overlay.motion?.enter ?? 'none'}
              options={ENTER_SELECT_OPTIONS}
              onChange={(event) => updateMotion({ enter: event.target.value as OverlayMotion['enter'] })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>出场</span>
            <Select
              className={styles.select}
              controlClassName={styles.selectControl}
              value={overlay.motion?.exit ?? 'none'}
              options={EXIT_SELECT_OPTIONS}
              onChange={(event) => updateMotion({ exit: event.target.value as OverlayMotion['exit'] })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>循环</span>
            <Select
              className={styles.select}
              controlClassName={styles.selectControl}
              value={overlay.motion?.loop ?? 'none'}
              options={LOOP_SELECT_OPTIONS}
              onChange={(event) => updateMotion({ loop: event.target.value as OverlayMotion['loop'] })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>入场时长</span>
            <NumberField
              className={styles.numberField}
              min={100}
              step={100}
              value={overlay.motion?.enterDurationMs ?? 400}
              onChange={(value) => updateMotion({ enterDurationMs: value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>出场时长</span>
            <NumberField
              className={styles.numberField}
              min={100}
              step={100}
              value={overlay.motion?.exitDurationMs ?? 400}
              onChange={(value) => updateMotion({ exitDurationMs: value })}
            />
          </label>
        </div>
        <div className={styles.helper}>媒体图层现在和文字图层共用同一套入场 / 循环 / 出场动画模型。</div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>位置</div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.label}>X</span>
            <span className={styles.value}>{overlay.position.x}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Y</span>
            <span className={styles.value}>{overlay.position.y}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>宽度</span>
            <span className={styles.value}>{overlay.position.width}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>高度</span>
            <span className={styles.value}>{overlay.position.height}</span>
          </div>
        </div>
      </section>

      <Button variant="destructive" className={styles.deleteButton} onClick={onDelete}>
        删除图层
      </Button>
    </div>
  );
}
