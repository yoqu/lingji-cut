import { BEAT_ROLE_LABELS, STORYBOARD_BEAT_ROLES, type MotionStoryboard, type StoryboardBeat } from '../../lib/motion-storyboard';
import { Button, Select, Textarea, type SelectOption } from '../../ui';
import { AppIcon } from '../AppIcon';
import { CuePicker, type StoryboardCueOption } from './CuePicker';
import styles from './StoryboardEditor.module.css';

const ROLE_OPTIONS: SelectOption[] = STORYBOARD_BEAT_ROLES.map((role) => ({
  value: role,
  label: BEAT_ROLE_LABELS[role],
}));

export function BeatList({
  beats,
  cueCount,
  cueOptions,
  onPatchBeat,
  onRemoveBeat,
}: {
  beats: MotionStoryboard['beats'];
  cueCount?: number;
  cueOptions?: StoryboardCueOption[];
  onPatchBeat: (index: number, updates: Partial<StoryboardBeat>) => void;
  onRemoveBeat: (index: number) => void;
}) {
  return (
    <div className={styles.beatList}>
      {beats.map((beat, index) => (
        <div className={styles.beat} key={index}>
          <span className={styles.beatIndex}>#{index}</span>
          <Select
            value={beat.role ?? ''}
            options={ROLE_OPTIONS}
            className={styles.beatRole}
            placeholder="角色"
            onChange={(event) => onPatchBeat(index, { role: event.target.value as StoryboardBeat['role'] })}
          />
          <CuePicker
            value={beat.cue}
            cueCount={cueCount}
            cueOptions={cueOptions}
            className={styles.beatCue}
            placeholder={index === 0 ? '入场' : '锚点'}
            onChange={(cue) => onPatchBeat(index, { cue })}
          />
          <Textarea
            size="sm"
            rows={2}
            resize="none"
            value={beat.adds}
            className={styles.beatText}
            placeholder="本拍新增的画面内容"
            onChange={(event) => onPatchBeat(index, { adds: event.target.value })}
          />
          <Button
            variant="secondary"
            size="sm"
            className={styles.iconButton}
            title="删除拍"
            disabled={beats.length <= 1}
            onClick={() => onRemoveBeat(index)}
          >
            <AppIcon name="trash-2" size={13} />
          </Button>
        </div>
      ))}
    </div>
  );
}
