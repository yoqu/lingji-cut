import { prefetch } from 'remotion';
import { resolveAssetSrc } from './asset-src';
import type { RenderableAudio } from './timeline-to-sequences';

type PrefetchHandle = ReturnType<typeof prefetch>;

interface AudioPreloadEntry {
  refs: number;
  audio: HTMLAudioElement | null;
  prefetchHandle: PrefetchHandle | null;
}

const audioPreloadCache = new Map<string, AudioPreloadEntry>();

function getAudioContentType(src: string): string | undefined {
  const clean = src.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.m4a')) return 'audio/mp4';
  if (clean.endsWith('.aac')) return 'audio/aac';
  if (clean.endsWith('.ogg') || clean.endsWith('.oga')) return 'audio/ogg';
  if (clean.endsWith('.flac')) return 'audio/flac';
  return undefined;
}

export function getPreviewAudioSources(audio: RenderableAudio[], podcastRevision?: number): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];

  for (const clip of audio) {
    const src = resolveAssetSrc(
      clip.assetPath,
      clip.id === 'podcast-audio' ? podcastRevision : undefined,
    );
    if (!src || seen.has(src)) continue;
    seen.add(src);
    sources.push(src);
  }

  return sources;
}

function retainAudioSource(src: string): () => void {
  const existing = audioPreloadCache.get(src);
  if (existing) {
    existing.refs += 1;
    return () => releaseAudioSource(src);
  }

  const audio =
    typeof window !== 'undefined' && typeof window.Audio === 'function'
      ? new window.Audio()
      : null;

  if (audio) {
    audio.preload = 'auto';
    audio.muted = true;
    audio.src = src;
    audio.load();
  }

  let prefetchHandle: PrefetchHandle | null = null;
  try {
    prefetchHandle = prefetch(src, {
      contentType: getAudioContentType(src),
      logLevel: 'warn',
    });
    void prefetchHandle.waitUntilDone().catch(() => undefined);
  } catch {
    prefetchHandle = null;
  }

  audioPreloadCache.set(src, {
    refs: 1,
    audio,
    prefetchHandle,
  });

  return () => releaseAudioSource(src);
}

function releaseAudioSource(src: string): void {
  const entry = audioPreloadCache.get(src);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  entry.prefetchHandle?.free();
  if (entry.audio) {
    entry.audio.pause();
    entry.audio.removeAttribute('src');
    entry.audio.load();
  }
  audioPreloadCache.delete(src);
}

export function preloadPreviewAudioSources(sources: string[]): () => void {
  if (sources.length === 0 || typeof window === 'undefined') {
    return () => undefined;
  }

  const releases = sources.map(retainAudioSource);
  return () => {
    for (const release of releases) {
      release();
    }
  };
}
