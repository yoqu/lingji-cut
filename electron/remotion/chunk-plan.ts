import type { OverlayItem, SrtEntry, TimelineData } from '../../src/types';
import { CARD_CROSSFADE_FRAMES } from '../../src/remotion/timeline-to-sequences';

export interface RenderChunk {
  index: number;
  startFrame: number;
  endFrame: number;
  frameCount: number;
}

export interface ChunkRenderInput {
  timeline: TimelineData;
  srtEntries: SrtEntry[];
  compiledCards: Record<string, string>;
}

export function planRenderChunks(
  durationInFrames: number,
  framesPerChunk: number,
): RenderChunk[] {
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
    throw new Error('durationInFrames must be a positive integer');
  }
  if (!Number.isInteger(framesPerChunk) || framesPerChunk < 1) {
    throw new Error('framesPerChunk must be a positive integer');
  }

  const chunks: RenderChunk[] = [];
  for (
    let startFrame = 0, index = 0;
    startFrame < durationInFrames;
    startFrame += framesPerChunk, index += 1
  ) {
    const endFrame = Math.min(
      durationInFrames - 1,
      startFrame + framesPerChunk - 1,
    );
    chunks.push({
      index,
      startFrame,
      endFrame,
      frameCount: endFrame - startFrame + 1,
    });
  }
  return chunks;
}

function intervalsIntersect(
  startMs: number,
  endMs: number,
  rangeStartMs: number,
  rangeEndExclusiveMs: number,
): boolean {
  return startMs < rangeEndExclusiveMs && endMs > rangeStartMs;
}

function overlayIntersectsChunk(
  item: OverlayItem,
  chunkStartMs: number,
  chunkEndExclusiveMs: number,
  crossfadePaddingMs: number,
): boolean {
  const isMotionCard = item.overlayType === 'ai-card';
  const padding = isMotionCard ? crossfadePaddingMs : 0;
  return intervalsIntersect(
    item.startMs,
    item.startMs + Math.max(0, item.durationMs),
    Math.max(0, chunkStartMs - padding),
    chunkEndExclusiveMs + padding,
  );
}

/**
 * Keep absolute timeline coordinates while removing data that cannot affect one render chunk.
 * The actual frameRange remains exact; only AI-card input selection receives transition padding.
 */
export function sliceChunkInput(
  input: ChunkRenderInput,
  chunk: RenderChunk,
  fps: number,
): ChunkRenderInput {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('fps must be positive');
  }

  const chunkStartMs = (chunk.startFrame / fps) * 1000;
  const chunkEndExclusiveMs = ((chunk.endFrame + 1) / fps) * 1000;
  const crossfadePaddingMs = (CARD_CROSSFADE_FRAMES / fps) * 1000;
  const overlays = input.timeline.overlays.filter((item) =>
    overlayIntersectsChunk(
      item,
      chunkStartMs,
      chunkEndExclusiveMs,
      crossfadePaddingMs,
    ),
  );
  const srtEntries = input.srtEntries.filter((entry) =>
    intervalsIntersect(
      entry.startMs,
      entry.endMs,
      chunkStartMs,
      chunkEndExclusiveMs,
    ),
  );
  const entryIndexes = new Set(srtEntries.map((entry) => entry.index));
  const compiledCards = Object.fromEntries(
    overlays
      .filter((item) => item.overlayType === 'ai-card')
      .map((item) => [item.id, input.compiledCards[item.id]] as const)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  return {
    timeline: {
      ...input.timeline,
      overlays,
      ...(input.timeline.editedSubtitles
        ? {
            editedSubtitles: input.timeline.editedSubtitles.filter((entry) =>
              intervalsIntersect(
                entry.startMs,
                entry.endMs,
                chunkStartMs,
                chunkEndExclusiveMs,
              ),
            ),
          }
        : {}),
      ...(input.timeline.subtitleHighlights
        ? {
            subtitleHighlights: input.timeline.subtitleHighlights.filter((highlight) =>
              entryIndexes.has(highlight.entryIndex),
            ),
          }
        : {}),
    },
    srtEntries,
    compiledCards,
  };
}
