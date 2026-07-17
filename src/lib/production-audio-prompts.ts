import type { AIAnalysisResult } from '../types/ai';
import type { MotionBible } from '../types/motion';

export const PODCAST_BGM_NEGATIVE_TAGS = [
  'vocals',
  'spoken word',
  'dense lead melody',
  'heavy kick',
  'abrupt drop',
  'busy midrange',
].join(', ');

function rhythmLabel(bible: MotionBible): string {
  if (bible.rhythm.density === 'dense') return 'steady 104-116 BPM, medium energy';
  if (bible.rhythm.density === 'quiet') return 'calm 72-88 BPM, low energy';
  return 'measured 88-102 BPM, low-to-medium energy';
}

export function buildPodcastBgmStyle(
  analysis: Pick<AIAnalysisResult, 'summary' | 'keywords'>,
  bible: MotionBible,
): string {
  const subject = [analysis.summary, analysis.keywords.slice(0, 6).join(', ')]
    .filter(Boolean)
    .join(' / ');
  return [
    'Instrumental editorial podcast underscore',
    subject ? `subject: ${subject}` : '',
    `visual tone: ${bible.visualThesis}`,
    `tempo and energy: ${rhythmLabel(bible)}`,
    'instrumentation: soft percussion, restrained bass, warm keys, subtle modern textures',
    'energy curve: clean opening, stable conversational bed, gentle chapter lifts, resolved ending',
    'mix: sparse arrangement, wide but controlled, leave the 1-4 kHz speech range clear',
    'no dramatic climax, no abrupt transitions',
  ].filter(Boolean).join('; ');
}

export function buildChapterStingerPrompt(title: string): string {
  return [
    `1.5-4 second editorial chapter stinger for “${title}”`,
    'clean tonal accent with a restrained directional lift',
    'single clear onset, short controlled tail, no voice, no melody phrase, no heavy sub bass',
  ].join('; ');
}

export function buildShotSfxPrompt(kind: 'whoosh' | 'impact', carrier: string): string {
  if (kind === 'whoosh') {
    return [
      `0.3-1.2 second clean directional whoosh for a ${carrier} transition`,
      'precise transient, light air texture, quick decay, no voice, no music, no long reverb',
    ].join('; ');
  }
  return [
    `0.2-0.8 second editorial information hit for ${carrier}`,
    'focused mid-low impact, crisp onset, controlled bass, very short tail',
    'no voice, no music, no cinematic boom, no distortion',
  ].join('; ');
}
