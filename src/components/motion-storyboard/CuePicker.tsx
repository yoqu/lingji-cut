import { useMemo } from 'react';
import { Select, type SelectOption } from '../../ui';

export interface StoryboardCueOption {
  index: number;
  startMs: number;
  text: string;
}

function formatCueLabel(option: StoryboardCueOption): string {
  const seconds = (option.startMs / 1000).toFixed(1);
  const text = option.text.length > 18 ? `${option.text.slice(0, 18)}...` : option.text;
  return `[${option.index}] ${seconds}s ${text}`;
}

export function cueToText(cue: number | null): string {
  return cue == null ? '' : String(cue);
}

export function textToCue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function CuePicker({
  value,
  cueCount = 0,
  cueOptions,
  className,
  placeholder,
  onChange,
}: {
  value: number | null;
  cueCount?: number;
  cueOptions?: StoryboardCueOption[];
  className?: string;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  const options = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '入场 / null' },
      ...(cueOptions ?? Array.from({ length: cueCount }, (_, index) => ({ index, startMs: 0, text: `cue ${index}` }))).map(
        (option) => ({ value: String(option.index), label: formatCueLabel(option) }),
      ),
    ],
    [cueCount, cueOptions],
  );

  return (
    <Select
      value={cueToText(value)}
      options={options}
      className={className}
      placeholder={placeholder}
      allowCustomValue
      onChange={(event) => onChange(textToCue(event.target.value))}
    />
  );
}
