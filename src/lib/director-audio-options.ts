import type { DirectorAudioDirection } from '../types/director';

export function isDirectorBgmEnabled(direction?: DirectorAudioDirection | null): boolean {
  return direction?.bgmEnabled !== false;
}

export function areDirectorSoundEffectsEnabled(direction?: DirectorAudioDirection | null): boolean {
  return direction?.soundEffectsEnabled !== false;
}

export function isDirectorAudioEnabled(direction?: DirectorAudioDirection | null): boolean {
  return isDirectorBgmEnabled(direction) || areDirectorSoundEffectsEnabled(direction);
}
