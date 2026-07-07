import type { TimelineData } from '../types';
import type { MediaCardContent } from '../types/ai';
export interface HyperframesAssetDescriptor {
  sourcePath: string;
  publicPath: string;
}

export interface PreparedHyperframesTimeline {
  timeline: TimelineData;
  assets: HyperframesAssetDescriptor[];
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/');
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

export function isFileProtocolUrl(value: string): boolean {
  return value.startsWith('file://');
}

export function isAbsoluteFilesystemPath(value: string): boolean {
  const normalized = normalizePathLike(value);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function sanitizeAssetLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
}

function getPathExtension(sourcePath: string): string {
  const normalized = normalizePathLike(sourcePath);
  const lastDotIndex = normalized.lastIndexOf('.');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastDotIndex <= lastSlashIndex) return '';
  return normalized.slice(lastDotIndex).toLowerCase();
}

function createPublicAssetPath(sourcePath: string, label: string): string {
  return `assets/${sanitizeAssetLabel(label)}${getPathExtension(sourcePath)}`;
}

export function hydrateAICardAssetPaths(
  timeline: TimelineData,
  projectDir: string | null | undefined,
): TimelineData {
  if (!projectDir) return timeline;
  const root = projectDir.replace(/[\\/]+$/, '');

  const resolve = (value: string | null | undefined): string | null | undefined => {
    if (!value) return value;
    if (isRemoteUrl(value) || isFileProtocolUrl(value) || isAbsoluteFilesystemPath(value)) {
      return value;
    }
    return `${root}/${value.replace(/^[\\/]+/, '')}`;
  };

  let mutated = false;
  const overlays = timeline.overlays.map((overlay) => {
    const card = overlay.aiCardData;
    if (!card?.content || typeof card.content !== 'object' || !('mediaType' in card.content)) {
      return overlay;
    }
    const media = card.content as MediaCardContent;
    const nextAssetPath = resolve(media.assetPath) ?? media.assetPath;
    const nextPosterPath = resolve(media.posterPath) ?? media.posterPath;
    if (nextAssetPath === media.assetPath && nextPosterPath === media.posterPath) {
      return overlay;
    }
    mutated = true;
    return {
      ...overlay,
      aiCardData: {
        ...card,
        content: {
          ...media,
          assetPath: nextAssetPath ?? null,
          posterPath: nextPosterPath ?? media.posterPath,
        } as MediaCardContent,
      },
    };
  });

  return mutated ? { ...timeline, overlays } : timeline;
}

export function prepareTimelineForHyperframes(
  timeline: TimelineData,
  projectDir?: string | null,
): PreparedHyperframesTimeline {
  const hydrated = hydrateAICardAssetPaths(timeline, projectDir);
  const sourceToPublicPath = new Map<string, string>();
  const assets: HyperframesAssetDescriptor[] = [];

  const registerAsset = (sourcePath: string | null | undefined, label: string): string => {
    if (!sourcePath) return '';
    if (!isAbsoluteFilesystemPath(sourcePath)) return sourcePath;

    const existing = sourceToPublicPath.get(sourcePath);
    if (existing) return existing;

    const publicPath = createPublicAssetPath(sourcePath, label);
    sourceToPublicPath.set(sourcePath, publicPath);
    assets.push({ sourcePath, publicPath });
    return publicPath;
  };

  return {
    timeline: {
      ...hydrated,
      podcast: {
        ...hydrated.podcast,
        audioPath: registerAsset(hydrated.podcast.audioPath, 'podcast-audio'),
      },
      overlays: hydrated.overlays.map((overlay) => {
        const aiCardData = overlay.aiCardData;
        const nextOverlay = {
          ...overlay,
          assetPath: registerAsset(overlay.assetPath, overlay.id),
        };
        if (
          aiCardData?.content &&
          typeof aiCardData.content === 'object' &&
          'mediaType' in aiCardData.content
        ) {
          const media = aiCardData.content as MediaCardContent;
          return {
            ...nextOverlay,
            aiCardData: {
              ...aiCardData,
              content: {
                ...media,
                assetPath: media.assetPath
                  ? registerAsset(media.assetPath, `${overlay.id}-media`)
                  : media.assetPath,
                posterPath: media.posterPath
                  ? registerAsset(media.posterPath, `${overlay.id}-poster`)
                  : media.posterPath,
              } as MediaCardContent,
            },
          };
        }
        return nextOverlay;
      }),
    },
    assets,
  };
}
