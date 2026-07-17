import { useCallback, useMemo } from 'react';
import { getFileNameFromPath, formatTime } from '../lib/utils';
import { useTimelineStore } from '../store/timeline';
import { Button, NumberField, Select, Switch } from '../ui';
import type { AudioOverlayData } from '../types';
import { createDefaultAudioOverlayData } from '../types';
import styles from './OverlayInspector.module.css';

interface AudioInspectorProps {
  overlayId: string;
  onDelete: () => void;
}

/**
 * 音频 overlay 的右侧详情面板：
 * - 基础信息（文件名、轨道、起始、时长、源长度）
 * - 音量 / 静音
 * - 淡入 / 淡出
 * - 源音频裁剪起点（trimStart）
 */
export function AudioInspector({ overlayId, onDelete }: AudioInspectorProps) {
  const timeline = useTimelineStore((state) => state.timeline);
  const updateOverlay = useTimelineStore((state) => state.updateOverlay);
  const overlay = timeline.overlays.find((item) => item.id === overlayId);

  const audioData = useMemo<AudioOverlayData>(() => {
    if (overlay?.audioData) {
      return overlay.audioData;
    }
    return createDefaultAudioOverlayData(overlay?.durationMs ?? 0);
  }, [overlay?.audioData, overlay?.durationMs]);

  const updateAudio = useCallback(
    (updates: Partial<AudioOverlayData>) => {
      if (!overlay) return;
      updateOverlay(overlayId, {
        audioData: {
          ...audioData,
          ...updates,
        },
      });
    },
    [audioData, overlay, overlayId, updateOverlay],
  );

  if (!overlay || overlay.type !== 'audio') {
    return <div className={styles.empty}>音频图层不存在</div>;
  }

  const sourceDurationMs = Math.max(audioData.sourceDurationMs, overlay.durationMs);
  const maxTrimStart = Math.max(0, sourceDurationMs - overlay.durationMs);
  // 淡入 / 淡出总和不得超过 clip 本身长度
  const maxFadeMs = Math.max(0, Math.floor(overlay.durationMs / 2));
  const volumePercent = Math.round((audioData.volume ?? 1) * 100);

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>基础</div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.label}>类型</span>
            <span className={styles.value}>音频</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>轨道</span>
            <span className={styles.value}>{overlay.trackId}</span>
          </div>
          <div className={[styles.field, styles.fieldWide].join(' ')}>
            <span className={styles.label}>素材</span>
            <span className={styles.value}>{getFileNameFromPath(overlay.assetPath) || '—'}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>起始</span>
            <span className={styles.value}>{formatTime(overlay.startMs)}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>时长</span>
            <span className={styles.value}>{formatTime(overlay.durationMs)}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>源长度</span>
            <span className={styles.value}>{formatTime(sourceDurationMs)}</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>毫秒精度</span>
            <span className={styles.value}>{overlay.durationMs} ms</span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>音量</div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.label}>音量（%）</span>
            <NumberField
              className={styles.numberField}
              min={0}
              max={150}
              step={5}
              value={volumePercent}
              onChange={(value) => updateAudio({ volume: Math.max(0, value) / 100 })}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>静音</span>
            <Switch
              checked={audioData.muted}
              onChange={(checked) => updateAudio({ muted: checked })}
              label={audioData.muted ? '已静音' : '未静音'}
            />
          </div>
        </div>
        <div className={styles.helper}>
          音量以线性值应用，100% 为原始响度；超过 100% 会放大但可能引入失真。
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>声音角色</div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.label}>用途</span>
            <Select
              value={audioData.role ?? 'sfx'}
              options={[
                { value: 'bgm', label: 'BGM' },
                { value: 'ambience', label: '环境声' },
                { value: 'stinger', label: '章节 Stinger' },
                { value: 'sfx', label: '短音效' },
                { value: 'transition-sound', label: '转场声音' },
              ]}
              onChange={(event) => updateAudio({ role: event.target.value as AudioOverlayData['role'] })}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>循环</span>
            <Switch
              checked={audioData.loop ?? false}
              onChange={(checked) => updateAudio({ loop: checked })}
              label={audioData.loop ? '循环播放' : '单次播放'}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>口播 Ducking</span>
            <Switch
              checked={audioData.ducking?.enabled ?? false}
              onChange={(enabled) => updateAudio({
                ducking: {
                  enabled,
                  reductionDb: audioData.ducking?.reductionDb ?? 6,
                  attackMs: audioData.ducking?.attackMs ?? 80,
                  releaseMs: audioData.ducking?.releaseMs ?? 350,
                  holdMs: audioData.ducking?.holdMs ?? 600,
                },
              })}
              label={audioData.ducking?.enabled ? '自动压低' : '不处理'}
            />
          </div>
          {audioData.ducking?.enabled ? (
            <label className={styles.field}>
              <span className={styles.label}>压低（dB）</span>
              <NumberField
                className={styles.numberField}
                min={1}
                max={18}
                step={1}
                value={audioData.ducking.reductionDb}
                onChange={(reductionDb) => updateAudio({
                  ducking: { ...audioData.ducking!, reductionDb },
                })}
              />
            </label>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>淡入 / 淡出</div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.label}>淡入（ms）</span>
            <NumberField
              className={styles.numberField}
              min={0}
              max={maxFadeMs}
              step={50}
              value={audioData.fadeInMs}
              onChange={(value) => updateAudio({ fadeInMs: Math.max(0, Math.min(maxFadeMs, value)) })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>淡出（ms）</span>
            <NumberField
              className={styles.numberField}
              min={0}
              max={maxFadeMs}
              step={50}
              value={audioData.fadeOutMs}
              onChange={(value) => updateAudio({ fadeOutMs: Math.max(0, Math.min(maxFadeMs, value)) })}
            />
          </label>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>裁剪</div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.label}>源起点（ms）</span>
            <NumberField
              className={styles.numberField}
              min={0}
              max={maxTrimStart}
              step={100}
              value={audioData.trimStartMs}
              onChange={(value) =>
                updateAudio({ trimStartMs: Math.max(0, Math.min(maxTrimStart, value)) })
              }
            />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>源区间</span>
            <span className={styles.value}>
              {formatTime(audioData.trimStartMs)} – {formatTime(audioData.trimStartMs + overlay.durationMs)}
            </span>
          </div>
        </div>
        <div className={styles.helper}>
          在时间线上左/右拖拽 clip 边缘可直接裁剪。这里的"源起点"对应源音频从哪一毫秒开始取样。
        </div>
      </section>

      <Button variant="destructive" className={styles.deleteButton} onClick={onDelete}>
        删除音频
      </Button>
    </div>
  );
}
