import { useEffect, useState } from 'react';
import { Field, FieldGrid, Input, Select, Switch } from '../../ui';
import type { AssetRecord, AssetRole, AssetUpdatePatch } from '../../types/assets';
import styles from './AudioAssetMetadataEditor.module.css';

const ROLE_OPTIONS = [
  { value: 'audio', label: '通用音频' },
  { value: 'bgm', label: 'BGM' },
  { value: 'ambience', label: '环境声' },
  { value: 'stinger', label: '章节 Stinger' },
  { value: 'sfx', label: '短音效' },
  { value: 'transition-sound', label: '转场音' },
];

const ENERGY_OPTIONS = [
  { value: '', label: '未标注' },
  { value: '1', label: '1 · 低能量' },
  { value: '2', label: '2 · 中能量' },
  { value: '3', label: '3 · 高能量' },
];

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function AudioAssetMetadataEditor({
  asset,
  onUpdate,
}: {
  asset: AssetRecord;
  onUpdate: (assetId: string, patch: AssetUpdatePatch) => void;
}) {
  const audio = asset.metadata.audio;
  const [bpm, setBpm] = useState(audio?.bpm?.toString() ?? '');
  const [key, setKey] = useState(audio?.key ?? '');
  const [transientType, setTransientType] = useState(audio?.transientType ?? '');
  const [loopStartMs, setLoopStartMs] = useState(audio?.loopStartMs?.toString() ?? '');
  const [loopEndMs, setLoopEndMs] = useState(audio?.loopEndMs?.toString() ?? '');
  const [tags, setTags] = useState(asset.semantic.tags.join(', '));

  useEffect(() => {
    setBpm(audio?.bpm?.toString() ?? '');
    setKey(audio?.key ?? '');
    setTransientType(audio?.transientType ?? '');
    setLoopStartMs(audio?.loopStartMs?.toString() ?? '');
    setLoopEndMs(audio?.loopEndMs?.toString() ?? '');
    setTags(asset.semantic.tags.join(', '));
  }, [asset.id, asset.semantic.tags, audio]);

  const updateAudio = (patch: AssetUpdatePatch['audio']) => onUpdate(asset.id, { audio: patch });
  return (
    <section className={styles.panel} aria-label="音频检索元数据">
      <div className={styles.heading}>音频检索元数据</div>
      <FieldGrid columns={2}>
        <Field label="素材角色">
          <Select
            value={asset.role}
            options={ROLE_OPTIONS}
            onChange={(event) => onUpdate(asset.id, { role: event.target.value as AssetRole })}
          />
        </Field>
        <Field label="能量">
          <Select
            value={audio?.energy?.toString() ?? ''}
            options={ENERGY_OPTIONS}
            onChange={(event) => updateAudio({
              energy: event.target.value ? Number(event.target.value) as 1 | 2 | 3 : undefined,
            })}
          />
        </Field>
        <Field label="BPM">
          <Input size="sm" type="number" min={1} value={bpm} onChange={(event) => setBpm(event.target.value)}
            onBlur={() => updateAudio({ bpm: optionalNumber(bpm) })} />
        </Field>
        <Field label="Key">
          <Input size="sm" value={key} placeholder="如 C minor" onChange={(event) => setKey(event.target.value)}
            onBlur={() => updateAudio({ key: key.trim() || null })} />
        </Field>
        <Field label="瞬态类型">
          <Input size="sm" value={transientType} placeholder="whoosh / impact / riser" onChange={(event) => setTransientType(event.target.value)}
            onBlur={() => updateAudio({ transientType: transientType.trim() || null })} />
        </Field>
        <Field label="循环能力">
          <Switch label="可无缝循环" checked={audio?.loopable === true}
            onChange={(checked) => updateAudio({ loopable: checked })} />
        </Field>
        <Field label="循环起点 (ms)">
          <Input size="sm" type="number" min={0} value={loopStartMs} onChange={(event) => setLoopStartMs(event.target.value)}
            onBlur={() => updateAudio({ loopStartMs: optionalNumber(loopStartMs) })} />
        </Field>
        <Field label="循环终点 (ms)">
          <Input size="sm" type="number" min={0} value={loopEndMs} onChange={(event) => setLoopEndMs(event.target.value)}
            onBlur={() => updateAudio({ loopEndMs: optionalNumber(loopEndMs) })} />
        </Field>
      </FieldGrid>
      <Field label="情绪与语义标签" hint="使用逗号分隔；这些标签会参与声音素材匹配评分。">
        <Input size="sm" value={tags} placeholder="克制, 专注, 现代" onChange={(event) => setTags(event.target.value)}
          onBlur={() => onUpdate(asset.id, { semantic: { tags: tags.split(/[,，]/u).map((item) => item.trim()).filter(Boolean) } })} />
      </Field>
    </section>
  );
}
