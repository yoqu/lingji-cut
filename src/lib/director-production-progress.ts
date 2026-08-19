import type { DirectorProductionProgress } from './director-production-client';

type DirectorProgressMap = Partial<
  Record<DirectorProductionProgress['track'] | 'director', Pick<DirectorProductionProgress, 'percent'>>
>;

export function monotonicDirectorProductionProgress(
  progress: DirectorProgressMap,
  previous: number,
): number {
  const values = Object.values(progress);
  const total = values.reduce((sum, item) => sum + (item?.percent ?? 0), 0);
  const average = Math.round(total / Math.max(1, values.length));
  return Math.max(previous, average);
}
