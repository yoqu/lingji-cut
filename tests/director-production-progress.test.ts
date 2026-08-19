import { describe, expect, it } from 'vitest';
import { monotonicDirectorProductionProgress } from '../src/lib/director-production-progress';

describe('monotonicDirectorProductionProgress', () => {
  it('does not move the task backwards when a newly reported track starts lower', () => {
    const progress: Record<string, { percent: number }> = {};
    let overall = 0;

    progress.cards = { percent: 76 };
    overall = monotonicDirectorProductionProgress(progress, overall);
    expect(overall).toBe(76);

    progress.cover = { percent: 10 };
    overall = monotonicDirectorProductionProgress(progress, overall);
    expect(overall).toBe(76);

    progress.cover = { percent: 80 };
    overall = monotonicDirectorProductionProgress(progress, overall);
    expect(overall).toBe(78);
  });
});
