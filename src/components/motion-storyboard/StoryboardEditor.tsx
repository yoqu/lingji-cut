import { useMemo } from 'react';
import {
  STORYBOARD_CARRIERS,
  STORYBOARD_EMPHASES,
  parseStoryboard,
  validateStoryboard,
  type MotionStoryboard,
  type StoryboardBeat,
} from '../../lib/motion-storyboard';
import { Button, Input, NumberField, PillGroup, Textarea, type PillGroupItem } from '../../ui';
import { AppIcon } from '../AppIcon';
import { BeatList } from './BeatList';
import type { StoryboardCueOption } from './CuePicker';
import type { MotionEmphasisKind } from '../../types/motion';
import styles from './StoryboardEditor.module.css';

const CARRIER_ITEMS: Array<PillGroupItem<string>> = STORYBOARD_CARRIERS.map((carrier) => ({
  value: carrier,
  label: carrier,
}));

const EMPHASIS_ITEMS: Array<PillGroupItem<MotionEmphasisKind>> = STORYBOARD_EMPHASES.map((emphasis) => ({
  value: emphasis,
  label: emphasis,
}));

function stringifyStoryboard(storyboard: MotionStoryboard): string {
  return JSON.stringify(storyboard, null, 2);
}

function fallbackStoryboard(): MotionStoryboard {
  return {
    claim: '',
    carrier: 'concept',
    scene: '',
    focus: { beat: 0, emphasis: 'brighten' },
    beats: [{ cue: null, kind: 'build', adds: '', motion: '' }],
  };
}

interface StoryboardEditorProps {
  value: string;
  cueCount?: number;
  cueOptions?: StoryboardCueOption[];
  transcript?: string;
  onChange: (value: string) => void;
}

export function StoryboardEditor({
  value,
  cueCount = 0,
  cueOptions,
  transcript,
  onChange,
}: StoryboardEditorProps) {
  const storyboard = useMemo(() => parseStoryboard(value) ?? fallbackStoryboard(), [value]);
  const validation = useMemo(
    () => validateStoryboard(storyboard, { cueCount, transcript }),
    [cueCount, storyboard, transcript],
  );

  const commit = (next: MotionStoryboard) => onChange(stringifyStoryboard(next));
  const patch = (updates: Partial<MotionStoryboard>) => commit({ ...storyboard, ...updates });
  const patchBeat = (index: number, updates: Partial<StoryboardBeat>) => {
    commit({
      ...storyboard,
      beats: storyboard.beats.map((beat, i) => (i === index ? { ...beat, ...updates } : beat)),
    });
  };
  const addBeat = () => {
    if (storyboard.beats.length >= 6) return;
    commit({
      ...storyboard,
      beats: [
        ...storyboard.beats,
        { cue: storyboard.beats.length === 0 ? null : 0, kind: 'build', adds: '', motion: '' },
      ],
    });
  };
  const removeBeat = (index: number) => {
    if (storyboard.beats.length <= 1) return;
    const beats = storyboard.beats.filter((_, i) => i !== index);
    commit({
      ...storyboard,
      beats,
      focus: storyboard.focus
        ? { ...storyboard.focus, beat: Math.min(storyboard.focus.beat, beats.length - 1) }
        : undefined,
    });
  };

  return (
    <div className={styles.editor} data-motion-storyboard-editor="true">
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>Claim</span>
          <Input
            size="sm"
            value={storyboard.claim}
            onChange={(event) => patch({ claim: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Focus</span>
          <NumberField
            value={storyboard.focus?.beat ?? 0}
            min={0}
            max={Math.max(0, storyboard.beats.length - 1)}
            step={1}
            onChange={(beat) =>
              patch({ focus: { beat: Math.round(beat), emphasis: storyboard.focus?.emphasis ?? 'brighten' } })
            }
          />
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Carrier</span>
        <PillGroup
          items={CARRIER_ITEMS}
          value={storyboard.carrier}
          onChange={(carrier) => patch({ carrier: carrier as MotionStoryboard['carrier'] })}
          size="sm"
          fullWidth
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Emphasis</span>
        <PillGroup
          items={EMPHASIS_ITEMS}
          value={storyboard.focus?.emphasis ?? 'brighten'}
          onChange={(emphasis) =>
            patch({ focus: { beat: storyboard.focus?.beat ?? 0, emphasis } })
          }
          size="sm"
          fullWidth
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Scene</span>
        <Textarea
          size="sm"
          rows={2}
          resize="none"
          value={storyboard.scene}
          onChange={(event) => patch({ scene: event.target.value })}
        />
      </label>

      <BeatList
        beats={storyboard.beats}
        cueCount={cueCount}
        cueOptions={cueOptions}
        onPatchBeat={patchBeat}
        onRemoveBeat={removeBeat}
      />

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<AppIcon name="plus" size={12} />}
          disabled={storyboard.beats.length >= 6}
          onClick={addBeat}
        >
          添加拍
        </Button>
      </div>

      {!validation.ok || validation.warnings.length > 0 ? (
        <div className={styles.validation}>
          {validation.errors.slice(0, 3).map((error) => (
            <span className={styles.validationError} key={error}>
              {error}
            </span>
          ))}
          {validation.warnings.slice(0, 2).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
