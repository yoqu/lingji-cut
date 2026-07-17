import { useEffect, useState } from 'react';
import { Music, Search, Sparkles, Volume2 } from 'lucide-react';
import { toFileSrc } from '../../lib/utils';
import type { MediaAssetCandidate } from '../../lib/media-asset-resolution';
import type { AssetRecord } from '../../types/assets';
import type { AudioCuePlan, MotionProductionPlan } from '../../types/production';
import { Button, Textarea } from '../../ui';
import styles from './ProductionAudio.module.css';

const ROLE_LABEL: Record<AudioCuePlan['role'], string> = {
  bgm: 'BGM', ambience: '环境声', stinger: 'Stinger', sfx: '音效', 'transition-sound': '转场音',
};

function PromptField({ cue, onCommit }: { cue: AudioCuePlan; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(cue.query);
  useEffect(() => setDraft(cue.query), [cue.query]);
  const music = cue.role === 'bgm' || cue.role === 'stinger';
  return (
    <label className={styles.promptEditor}>
      <span>{music ? 'Suno style prompt' : 'Suno Sounds prompt'}</span>
      <Textarea value={draft} onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() && draft !== cue.query && onCommit(draft.trim())}
        rows={5} size="sm" resize="vertical" />
    </label>
  );
}

function CandidateList({ candidates, onSelect }: {
  candidates: MediaAssetCandidate[];
  onSelect: (asset: AssetRecord) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className={styles.candidates}>
      <span className={styles.candidateTitle}>本地候选，需要导演确认</span>
      {candidates.slice(0, 3).map(({ asset, score, reasons }) => (
        <div className={styles.candidateRow} key={asset.id}>
          <div><strong>{asset.name}</strong><span>{score} 分 · {reasons.join(' · ') || '技术规格符合'}</span></div>
          <audio src={toFileSrc(asset.files.processed || asset.files.original)} controls preload="metadata" />
          <Button variant="secondary" size="xs" onClick={() => onSelect(asset)}>使用</Button>
        </div>
      ))}
      <span className={styles.candidateHint}>低于 75 分不会自动复用；确认后会加入当前项目并放入声音轨。</span>
    </div>
  );
}

function CueRow({ cue, asset, candidates, credits, working, onPromptChange, onSearch, onGenerate, onSelect }: {
  cue: AudioCuePlan;
  asset?: AssetRecord;
  candidates: MediaAssetCandidate[];
  credits: number | null;
  working: boolean;
  onPromptChange: (query: string) => void;
  onSearch: () => void;
  onGenerate: () => void;
  onSelect: (asset: AssetRecord) => void;
}) {
  const music = cue.role === 'bgm' || cue.role === 'stinger';
  return (
    <article className={styles.cueRow}>
      <div className={styles.cueHeader}><div className={styles.cueIdentity}>
        {music ? <Music size={14} /> : <Volume2 size={14} />}<strong>{ROLE_LABEL[cue.role]}</strong>
        <span>{Math.round(cue.startMs / 100) / 10}s</span>
      </div><span className={asset ? styles.readyStatus : styles.missingStatus}>{asset ? '已入库并上轨' : cue.required ? '必需·缺失' : '可选·缺失'}</span></div>
      <div className={styles.requestMeta}><span>模型 V5</span><span>{music ? 'Instrumental' : cue.loop ? 'Loop' : 'One-shot'}</span><span>{Math.round((cue.durationMs ?? 0) / 100) / 10}s</span></div>
      <PromptField cue={cue} onCommit={onPromptChange} />
      {asset ? <audio className={styles.audioPlayer} src={toFileSrc(asset.files.processed || asset.files.original)} controls preload="metadata" /> : null}
      <CandidateList candidates={candidates} onSelect={onSelect} />
      <div className={styles.cueFooter}><span>{cue.volumeDb ?? -12} dB · {cue.loop ? '循环' : '单次'} · 本地优先</span><div>
        <Button variant="secondary" size="xs" loading={working} onClick={onSearch}><Search size={12} />检索素材库</Button>
        <Button variant="primary" size="xs" loading={working} disabled={credits === 0} onClick={onGenerate}><Sparkles size={12} />Suno 生成缺失</Button>
      </div></div>
    </article>
  );
}

export function ProductionAudio({ plan, assets, credits, candidates, workingCueId, onPromptChange, onSearch, onGenerate, onSelect }: {
  plan: MotionProductionPlan;
  assets: AssetRecord[];
  credits: number | null;
  candidates: Record<string, MediaAssetCandidate[]>;
  workingCueId: string | null;
  onPromptChange: (cueId: string, query: string) => void;
  onSearch: (cue: AudioCuePlan) => void;
  onGenerate: (cue: AudioCuePlan) => void;
  onSelect: (cue: AudioCuePlan, asset: AssetRecord) => void;
}) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const groups = [['BGM', plan.audioPlan.bgm], ['环境声', plan.audioPlan.ambience],
    ['章节与重点声音', [...plan.audioPlan.stingers, ...plan.audioPlan.sfx]]] as const;
  return <div className={styles.view}>
    <div className={styles.audioSummary}><div><span>SunoAPI credits</span><strong>{credits ?? '—'}</strong></div><div><span>口播 Ducking</span><strong>-{plan.audioPlan.ducking.reductionDb} dB</strong></div><div><span>母带目标</span><strong>{plan.audioPlan.mastering.targetLufs} LUFS</strong></div></div>
    {credits === 0 ? <div className={styles.inlineWarning}>当前 credits 为 0。仍可检索和使用本地素材，Suno 生成已停用。</div> : null}
    {groups.map(([label, cues]) => <section className={styles.section} key={label}>
      <div className={styles.sectionHeading}>{label} · {cues.length}</div>
      {cues.length === 0 ? <p className={styles.emptyLine}>本片没有规划该类声音</p> : <div className={styles.cueList}>{cues.map((cue) => <CueRow key={cue.id} cue={cue} asset={cue.assetId ? assetMap.get(cue.assetId) : undefined} candidates={candidates[cue.id] ?? []} credits={credits} working={workingCueId === cue.id} onPromptChange={(query) => onPromptChange(cue.id, query)} onSearch={() => onSearch(cue)} onGenerate={() => onGenerate(cue)} onSelect={(asset) => onSelect(cue, asset)} />)}</div>}
    </section>)}
  </div>;
}
