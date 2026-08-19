import type { AISettings } from '../../src/types/ai';
import path from 'node:path';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type DirectorPlan,
  type ProjectProductionState,
} from '../../src/types/director';
import {
  EMPTY_FOOTAGE_TRACK_RESULT,
  type DirectorCompositionAsset,
  type FootageCompositionInput,
  type FootagePlacement,
  type FootageTrackResult,
  type KacutClip,
} from '../../src/types/footage';
import { decideFootageMatch } from '../../src/lib/footage-match';
import {
  areFootageArtifactsCurrent,
  freezeFootageCompositionInput,
  freezeFootagePlacement,
  type FootageFingerprintReader,
} from '../../src/lib/footage-fingerprint';
import { checkKacutHealth, searchKacutClips } from '../footage/kacut-client';
import { readLocalFileFingerprint } from '../footage/file-fingerprint';

const SEARCH_LIMIT = 5;

function fallbackVisualType(segment: DirectorPlan['segments'][number]): 'image' | 'motion' {
  return segment.footageFallback === 'image' ? 'image' : 'motion';
}

function validCompositionAssets(
  segment: DirectorPlan['segments'][number],
): DirectorCompositionAsset[] {
  const hasExplicitAssets = Array.isArray(segment.compositionAssets)
    && segment.compositionAssets.length > 0;
  const explicit = Array.isArray(segment.compositionAssets)
    ? segment.compositionAssets.filter((input) => (
        input
        && (input.usage === 'required' || input.usage === 'optional')
        && input.asset?.path?.trim()
        && (input.asset.kind === 'video' || input.asset.kind === 'image')
      ))
    : [];
  if (resolveDirectorRenderStrategy(segment) === 'standalone-media') {
    const required = explicit.find((input) => input.usage === 'required');
    if (required) return [required];
    if (hasExplicitAssets) return [];
  }
  if (explicit.length > 0) return explicit;
  const selected = segment.selectedFootage;
  return selected?.path?.trim() && (selected.kind === 'video' || selected.kind === 'image')
    ? [{ asset: selected, usage: 'required' }]
    : [];
}

function trimStartMs(input: DirectorCompositionAsset): number {
  if (input.asset.kind !== 'video') return 0;
  if (Number.isFinite(input.trimStartMs)) return Math.max(0, Math.round(input.trimStartMs ?? 0));
  return Math.max(0, Math.round((input.asset.matchedSegmentStart ?? 0) * 1_000));
}

function makeCompositionInput(
  segment: DirectorPlan['segments'][number],
  segmentIndex: number,
  input: DirectorCompositionAsset,
): FootageCompositionInput {
  return {
    segmentIndex,
    segmentId: segment.id,
    startMs: segment.startMs,
    durationMs: Math.max(1, Math.round(segment.endMs - segment.startMs)),
    asset: input.asset,
    usage: input.usage,
    trimStartMs: trimStartMs(input),
  };
}

function makePlacement(
  segment: DirectorPlan['segments'][number],
  segmentIndex: number,
  input: DirectorCompositionAsset & { fileFingerprint?: string },
): FootagePlacement {
  return {
    segmentIndex,
    segmentId: segment.id,
    overlayId: `footage-${segment.id}`,
    startMs: segment.startMs,
    durationMs: Math.max(1, Math.round(segment.endMs - segment.startMs)),
    sourcePath: input.asset.path,
    fileFingerprint: input.fileFingerprint,
    kind: input.asset.kind,
    trimStartMs: trimStartMs(input),
    score: Number.isFinite(input.asset.score) ? input.asset.score : 0,
    thumbnailFile: input.asset.thumbnailFile,
    composition: segment.composition,
    cameraMove: segment.cameraMove,
    mediaRole: segment.mediaRole,
  };
}

export async function runHeadlessFootageTrack(options: {
  production: ProjectProductionState;
  plan: DirectorPlan;
  settings: AISettings;
  projectPath?: string;
  readFingerprint?: FootageFingerprintReader;
}): Promise<FootageTrackResult> {
  const { production, plan, settings } = options;
  const readFingerprint: FootageFingerprintReader = options.readFingerprint ?? ((filePath) => {
    const resolved = path.isAbsolute(filePath) || !options.projectPath
      ? filePath
      : path.resolve(options.projectPath, filePath);
    return readLocalFileFingerprint(resolved);
  });
  const targets = plan.segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(({ segment }) => (
      segment.enabled && resolveDirectorRenderStrategy(segment) !== 'motion-card'
    ));
  if (targets.length === 0 || production.legacyProtected) return EMPTY_FOOTAGE_TRACK_RESULT;

  const impacted = production.pendingImpact;
  const cardsImpacted = Boolean(impacted && (impacted.allCards || impacted.segmentIds.length > 0));
  const persisted = production.footage;
  const expectedFingerprint = `footage-${plan.inputFingerprint}-${plan.revision}`;
  const persistedFilesCurrent = persisted
    ? await areFootageArtifactsCurrent(
        persisted.placements,
        persisted.compositionInputs ?? [],
        readFingerprint,
      )
    : false;
  if (
    !cardsImpacted
    && persisted
    && persistedFilesCurrent
    && production.outputs.footage?.status === 'current'
    && production.outputs.footage.directorRevision === plan.revision
    && persisted.generationProvenance?.directorRevision === plan.revision
    && persisted.generationProvenance.fingerprint === expectedFingerprint
  ) {
    return {
      ran: false,
      reused: true,
      placements: persisted.placements,
      compositionInputs: persisted.compositionInputs ?? [],
      claimedSegmentIds: persisted.claimedSegmentIds,
      fallbacks: persisted.fallbacks,
      blockedSegmentIds: persisted.blockedSegmentIds ?? [],
    };
  }

  const fallbacks: FootageTrackResult['fallbacks'] = [];
  const blockedSegmentIds: string[] = [];
  const applyMissingAssetFallbacks = (items: typeof targets) => {
    for (const { segment } of items) {
      if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
        if (resolveDirectorFallbackPolicy(segment) === 'motion') {
          fallbacks.push({
            segmentId: segment.id,
            visualType: 'motion',
            renderStrategy: 'motion-card',
          });
        } else {
          blockedSegmentIds.push(segment.id);
        }
        continue;
      }
      if (
        segment.renderStrategy === 'standalone-media'
        && segment.compositionAssets?.some((binding) => binding.usage === 'required')
      ) {
        blockedSegmentIds.push(segment.id);
        continue;
      }
      fallbacks.push({ segmentId: segment.id, visualType: fallbackVisualType(segment) });
    }
  };
  const manualAssets = new Map(
    targets.map(({ segment }) => [segment.id, validCompositionAssets(segment)] as const),
  );
  const manualTargets = targets.filter(({ segment }) => (
    (manualAssets.get(segment.id)?.length ?? 0) > 0
  ));
  const manualIds = new Set(manualTargets.map(({ segment }) => segment.id));
  const automaticTargets = targets.filter(({ segment }) => !manualIds.has(segment.id));
  const manualPlacements: FootagePlacement[] = [];
  const compositionInputs: FootageCompositionInput[] = [];
  for (const { segment, segmentIndex } of manualTargets) {
    const assets = manualAssets.get(segment.id) ?? [];
    const frozenAssets = await Promise.all(assets.map(async (input) => ({
      input,
      frozen: await freezeFootageCompositionInput(
        makeCompositionInput(segment, segmentIndex, input),
        readFingerprint,
      ),
    })));
    const requiredInvalid = frozenAssets.some(({ input, frozen }) => input.usage === 'required' && !frozen);
    const validInputs = frozenAssets.flatMap(({ frozen }) => frozen ? [frozen] : []);
    if (requiredInvalid || validInputs.length === 0) {
      applyMissingAssetFallbacks([{ segment, segmentIndex }]);
      continue;
    }
    if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
      compositionInputs.push(...validInputs);
    } else {
      const primary = validInputs.find((input) => input.usage === 'required') ?? validInputs[0];
      const placement = await freezeFootagePlacement(
        makePlacement(segment, segmentIndex, primary),
        readFingerprint,
      );
      if (placement) manualPlacements.push(placement);
      else applyMissingAssetFallbacks([{ segment, segmentIndex }]);
    }
  }
  if (automaticTargets.length === 0) {
    return {
      ran: true,
      placements: manualPlacements,
      compositionInputs,
      claimedSegmentIds: manualPlacements.map((placement) => placement.segmentId),
      fallbacks,
      blockedSegmentIds,
    };
  }
  const baseUrl = settings.kacut?.baseUrl?.trim() ?? '';
  if (!settings.kacut?.enabled || !baseUrl) {
    applyMissingAssetFallbacks(automaticTargets);
    return {
      ran: true,
      placements: manualPlacements,
      compositionInputs,
      claimedSegmentIds: manualPlacements.map((placement) => placement.segmentId),
      fallbacks,
      blockedSegmentIds,
    };
  }

  try {
    await checkKacutHealth(baseUrl);
  } catch (error) {
    applyMissingAssetFallbacks(automaticTargets);
    return {
      ran: true,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
      placements: manualPlacements,
      compositionInputs,
      claimedSegmentIds: manualPlacements.map((placement) => placement.segmentId),
      fallbacks,
      blockedSegmentIds,
    };
  }

  try {
    const results = await Promise.all(automaticTargets.map(async ({ segment, segmentIndex }) => {
      const query = segment.footageQuery?.trim() ?? '';
      let top: KacutClip | null = null;
      let kind: 'video' | 'image' = 'video';
      if (query) {
        try {
          const videos = await searchKacutClips(baseUrl, { query, kind: 'video', limit: SEARCH_LIMIT });
          top = [...videos].sort((left, right) => right.score - left.score)[0] ?? null;
          if (!top) {
            kind = 'image';
            const images = await searchKacutClips(baseUrl, { query, kind: 'image', limit: SEARCH_LIMIT });
            top = [...images].sort((left, right) => right.score - left.score)[0] ?? null;
          }
        } catch {
          return { missing: { segment, segmentIndex } };
        }
      }
      const verdict = decideFootageMatch(top?.score ?? null, fallbackVisualType(segment));
      if (verdict.decision !== 'adopt' || !top) {
        return { missing: { segment, segmentIndex } };
      }
      const matchedAsset: DirectorCompositionAsset = {
        usage: 'required',
        asset: {
          id: top.id,
          filename: top.filename,
          path: top.path,
          kind,
          score: top.score,
          durationSec: top.durationSec,
          thumbnailFile: top.thumbnailFile,
          matchedSegmentStart: top.matchedSegmentStart,
          pixelWidth: top.pixelWidth,
          pixelHeight: top.pixelHeight,
        },
      };
      if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
        const compositionInput = await freezeFootageCompositionInput(
          makeCompositionInput(segment, segmentIndex, matchedAsset),
          readFingerprint,
        );
        return compositionInput
          ? { compositionInput }
          : { missing: { segment, segmentIndex } };
      }
      const placement = await freezeFootagePlacement(
        makePlacement(segment, segmentIndex, matchedAsset),
        readFingerprint,
      );
      return placement ? { placement } : { missing: { segment, segmentIndex } };
    }));
    applyMissingAssetFallbacks(
      results.flatMap((result) => result.missing ? [result.missing] : []),
    );
    const placements = [
      ...manualPlacements,
      ...results.flatMap((result) => result.placement ? [result.placement] : []),
    ]
      .sort((left, right) => left.startMs - right.startMs);
    compositionInputs.push(
      ...results.flatMap((result) => result.compositionInput ? [result.compositionInput] : []),
    );
    compositionInputs.sort((left, right) => left.startMs - right.startMs);
    return {
      ran: true,
      placements,
      compositionInputs,
      claimedSegmentIds: placements.map((placement) => placement.segmentId),
      fallbacks,
      blockedSegmentIds,
    };
  } catch (error) {
    applyMissingAssetFallbacks(automaticTargets);
    return {
      ran: true,
      error: error instanceof Error ? error.message : String(error),
      placements: manualPlacements,
      compositionInputs,
      claimedSegmentIds: manualPlacements.map((placement) => placement.segmentId),
      fallbacks,
      blockedSegmentIds,
    };
  }
}
