import type { FootageCompositionInput, FootagePlacement } from '../types/footage';

export type FootageFingerprintReader = (filePath: string) => Promise<string | null>;

export async function freezeFootageCompositionInput(
  input: FootageCompositionInput,
  readFingerprint: FootageFingerprintReader,
): Promise<FootageCompositionInput | null> {
  const fileFingerprint = await readFingerprint(input.asset.path).catch(() => null);
  return fileFingerprint ? { ...input, fileFingerprint } : null;
}

export async function freezeFootagePlacement(
  placement: FootagePlacement,
  readFingerprint: FootageFingerprintReader,
): Promise<FootagePlacement | null> {
  const fileFingerprint = await readFingerprint(placement.sourcePath).catch(() => null);
  return fileFingerprint ? { ...placement, fileFingerprint } : null;
}

export async function isFootageCompositionInputCurrent(
  input: FootageCompositionInput,
  readFingerprint: FootageFingerprintReader,
): Promise<boolean> {
  if (!input.fileFingerprint) return false;
  return await readFingerprint(input.asset.path).catch(() => null) === input.fileFingerprint;
}

export async function isFootagePlacementCurrent(
  placement: FootagePlacement,
  readFingerprint: FootageFingerprintReader,
): Promise<boolean> {
  if (!placement.fileFingerprint) return false;
  return await readFingerprint(placement.sourcePath).catch(() => null) === placement.fileFingerprint;
}

export async function areFootageArtifactsCurrent(
  placements: FootagePlacement[],
  compositionInputs: FootageCompositionInput[],
  readFingerprint: FootageFingerprintReader,
): Promise<boolean> {
  const results = await Promise.all([
    ...placements.map((placement) => isFootagePlacementCurrent(placement, readFingerprint)),
    ...compositionInputs.map((input) => isFootageCompositionInputCurrent(input, readFingerprint)),
  ]);
  return results.every(Boolean);
}
