import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { runTTSProvider, type TTSRunnerOptions, type TTSRunnerResult } from '../../tts-provider-runner';
import { loadHeadlessTTSConfig, loadFullHeadlessAISettings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import { HeadlessProjectContext } from '../context';
import { loadProjectFile } from '../../project-file';
import { createDefaultTimeline } from '../../../src/types';
import {
  MIMO_TTS_CHUNK_CHAR_BUDGET,
  groupSentencesByBudget,
  isTruncatedMimoChunk,
  type ChunkPart,
} from '../../tts-chunking';
import { buildAlignedSrtFromChunks, type TtsTranscribe } from '../../tts-srt-align';
import { concatWavFiles } from '../../media-concat';
import { readAudioDurationMs } from '../../media-duration';
import { listUserPromptEntries } from '../../user-prompts-io';
import { resolveMimoStyleInstruction } from '../../../src/lib/tts/mimo-style';
import { splitIntoSentences } from '../../../src/lib/tts/sentence-split';
import { annotateForMimo } from '../../../src/lib/tts/mimo-annotate';
import type { TtsUnit } from '../../../src/lib/tts/types';
import type { GenerationRunCtx } from '../headless-generation';

export interface TtsRunResult {
  audioPath: string;
  srtPath: string;
  durationMs: number;
}

export interface RuntimeMediaBinaries {
  ffmpegPath: string | null;
  ffprobePath: string | null;
}

interface TtsRunDeps {
  runner?: (options: TTSRunnerOptions) => Promise<TTSRunnerResult>;
  resolveBinaries?: () => Promise<RuntimeMediaBinaries> | RuntimeMediaBinaries;
  transcribe?: TtsTranscribe;
}

async function loadDefaultBinaries(): Promise<RuntimeMediaBinaries> {
  try {
    const electron = await import('electron');
    const { resolveFfmpegPath, resolveFfprobePath } = await import('../../runtime-binaries');
    const { existsSync } = await import('node:fs');
    const app = electron.app;
    const options = {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      cwd: process.cwd(),
      moduleDir: __dirname,
      existsSync,
    };
    return {
      ffmpegPath: resolveFfmpegPath(options),
      ffprobePath: resolveFfprobePath(options),
    };
  } catch {
    return { ffmpegPath: null, ffprobePath: null };
  }
}

/**
 * 主进程 headless 生成口播音频 + 字幕。
 * - MiniMax：单次 runner 调用，沿用接口返回的 SRT/时长
 * - 小米 MiMo：取项目模板的演绎人设 + 句级 AI 打标 + 按字数预算分块 + 逐块合成 + ffmpeg 拼接，
 *   并按每块真实时长构造多条字幕。runner / 二进制路径均可注入用于测试。
 */
export async function runTtsHeadless(
  ctx: GenerationRunCtx,
  deps: TtsRunDeps = {},
): Promise<TtsRunResult> {
  const runner = deps.runner ?? runTTSProvider;
  const { projectPath, userDataPath, handle } = ctx;

  handle.update({ phase: '装配设置', percent: 5 });
  const { provider, voice } = await loadHeadlessTTSConfig(userDataPath);
  if (provider.type !== 'minimax' && provider.type !== 'xiaomi_mimo') {
    throw new GenerationError(
      'unsupported_tts',
      `headless TTS 暂未支持 provider 类型 ${provider.type}，请在应用界面手动触发。`,
    );
  }

  let text: string;
  try {
    text = await readFile(join(projectPath, 'script.md'), 'utf-8');
  } catch {
    throw new GenerationError('no_script', '未找到 script.md，请先生成口播稿。');
  }
  if (!text.trim()) {
    throw new GenerationError('empty_script', 'script.md 为空。');
  }

  let audioPath: string;
  let durationMs = 0;
  let srtText = '';

  if (provider.type === 'minimax') {
    handle.update({ phase: '合成语音', percent: 20 });
    const result = await runner({ text, provider, voice, signal: handle.signal });
    if (!result.audioBuffer?.length) {
      throw new GenerationError('empty_audio', 'TTS 返回空音频。');
    }
    handle.update({ phase: '写入文件', percent: 80 });
    await mkdir(projectPath, { recursive: true });
    audioPath = join(projectPath, `podcast-audio.${result.audioExtension}`);
    await writeFile(audioPath, result.audioBuffer);
    durationMs =
      result.durationMs && result.durationMs > 0
        ? result.durationMs
        : Math.max(1000, text.length * 200);
    srtText = result.subtitleText ?? '';
  } else {
    const mimo = await runMimoChunked({
      text,
      provider,
      voice,
      projectPath,
      userDataPath,
      handle,
      runner,
      deps,
    });
    audioPath = mimo.audioPath;
    durationMs = mimo.durationMs;
    srtText = mimo.srtText;
  }

  handle.update({ phase: '写入文件', percent: 90 });
  const srtPath = join(projectPath, 'podcast-subtitles.srt');
  const originalSrtPath = join(projectPath, 'podcast-subtitles.original.srt');
  await writeFile(srtPath, srtText, 'utf-8');
  await writeFile(originalSrtPath, srtText, 'utf-8');

  // 写回 project.json 的 timeline.podcast 指针，使已打开项目的 UI 刷新
  // （App.tsx reloadProjectSections('timeline')）能 surface 新生成的音频/字幕。
  handle.update({ phase: '写入工程', percent: 95 });
  const headless = new HeadlessProjectContext(projectPath);
  const existing = (await loadProjectFile(projectPath)).timeline;
  const base = existing ?? createDefaultTimeline();
  await headless.saveSection('timeline', {
    ...base,
    podcast: { audioPath, srtPath, durationMs },
  });

  handle.update({ phase: '完成', percent: 100 });
  return { audioPath, srtPath, durationMs };
}

interface MimoChunkedArgs {
  text: string;
  provider: import('../../../src/types/ai').TTSProvider;
  voice: import('../../../src/types/ai').TTSVoicePreset;
  projectPath: string;
  userDataPath: string;
  handle: GenerationRunCtx['handle'];
  runner: (options: TTSRunnerOptions) => Promise<TTSRunnerResult>;
  deps: TtsRunDeps;
}

async function runMimoChunked(args: MimoChunkedArgs): Promise<{
  audioPath: string;
  durationMs: number;
  srtText: string;
}> {
  const { text, provider, voice, projectPath, userDataPath, handle, runner, deps } = args;

  handle.update({ phase: '准备分句', percent: 15 });
  const sentences = await buildMimoSentences({ text, userDataPath, projectPath });
  if (sentences.length === 0) {
    throw new GenerationError('empty_script', 'script.md 没有可合成的句子。');
  }

  const chunks = groupSentencesByBudget(sentences, MIMO_TTS_CHUNK_CHAR_BUDGET);
  const styleInstruction = await resolveProjectMimoStyleInstruction(projectPath, userDataPath);

  handle.update({ phase: '探测 ffmpeg', percent: 22 });
  const binaries = await (deps.resolveBinaries
    ? Promise.resolve(deps.resolveBinaries())
    : loadDefaultBinaries());
  const { ffmpegPath, ffprobePath } = binaries;
  if (!ffmpegPath) {
    throw new GenerationError(
      'missing_ffmpeg',
      'ffmpeg 未找到，无法合并 MiMo 分块音频。请确认应用打包了 ffmpeg 二进制。',
    );
  }

  await mkdir(projectPath, { recursive: true });
  const audioPath = join(projectPath, 'podcast-audio.wav');
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'lingji-tts-headless-'));
  const parts: ChunkPart[] = [];
  const partPaths: string[] = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const speakText = chunks[i].map((u) => u.speak).join('');
      const chunkChars = chunks[i].reduce((n, u) => n + u.subtitle.length, 0);
      const partPath = join(tmpDir, `chunk-${i}.wav`);
      let ok = false;
      let durMs = 0;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= 2 && !ok; attempt++) {
        try {
          const r = await runner({
            text: speakText,
            provider,
            voice,
            signal: handle.signal,
            styleInstruction,
            speakText,
          });
          if (r.audioBuffer.byteLength === 0) {
            lastErr = new Error('MiMo 返回空音频');
            continue;
          }
          await writeFile(partPath, r.audioBuffer);
          try {
            if (!ffprobePath) throw new Error('ffprobe 未找到');
            durMs = await readAudioDurationMs(partPath, { ffprobePath });
          } catch {
            durMs = Math.max(1_000, chunkChars * 200);
          }
          if (isTruncatedMimoChunk(durMs, chunkChars)) {
            const msg = `MiMo 第 ${i + 1} 块音频疑似截断（${durMs}ms / ${chunkChars} 字），第 ${attempt + 1} 次重试`;
            handle.log(`[warn] ${msg}`);
            lastErr = new Error(msg);
            continue;
          }
          ok = true;
        } catch (err) {
          lastErr = err;
          if ((err as { name?: string }).name === 'AbortError') throw err;
        }
      }
      if (!ok) {
        throw lastErr instanceof Error ? lastErr : new Error('MiMo 分块合成失败');
      }
      partPaths.push(partPath);
      parts.push({ durMs, units: chunks[i] });

      const pct = 25 + Math.round((55 * (i + 1)) / chunks.length);
      handle.update({ phase: `合成语音 ${i + 1}/${chunks.length}`, percent: pct });
    }

    handle.update({ phase: '拼接音频', percent: 82 });
    await concatWavFiles(partPaths, audioPath, { ffmpegPath });
    const durationMs = parts.reduce((sum, p) => sum + p.durMs, 0);
    handle.update({ phase: 'ASR 校准字幕', percent: 88 });
    const { srtText } = await buildAlignedSrtFromChunks({
      audioPath,
      parts,
      signal: handle.signal,
      transcribe: deps.transcribe,
      log: (level, message) => handle.log(`[${level}] ${message}`),
    });
    return { audioPath, durationMs, srtText };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** 从项目 script.templateId 取模板的 ttsAnnotateHint，调 LLM 打标得到每句标签。 */
async function buildMimoSentences(args: {
  text: string;
  userDataPath: string;
  projectPath: string;
}): Promise<TtsUnit[]> {
  const clean = splitIntoSentences(args.text);
  if (clean.length === 0) return [];

  let hint = '';
  try {
    const templateId = await readProjectTemplateId(args.projectPath);
    if (templateId) {
      const entries = await listUserPromptEntries('script-template', {
        userDataPath: args.userDataPath,
      });
      const template = entries.find((e) => e.id === templateId);
      hint = template?.ttsAnnotateHint ?? '';
    }
  } catch {
    // 模板缺失：默认不打标
  }

  let tags: Array<string | null> = clean.map(() => null);
  try {
    const settings = await loadFullHeadlessAISettings(args.userDataPath);
    tags = await annotateForMimo(clean, hint, settings);
  } catch {
    // LLM 失败 → 全 null，照样合成
  }

  return clean.map((s, i) => ({
    subtitle: s,
    speak: tags[i] ? `(${tags[i]})${s}` : s,
  }));
}

async function resolveProjectMimoStyleInstruction(
  projectPath: string,
  userDataPath: string,
): Promise<string | undefined> {
  try {
    const templateId = await readProjectTemplateId(projectPath);
    if (!templateId) return resolveMimoStyleInstruction(undefined);
    const entries = await listUserPromptEntries('script-template', { userDataPath });
    const template = entries.find((e) => e.id === templateId);
    return resolveMimoStyleInstruction(template);
  } catch {
    return resolveMimoStyleInstruction(undefined);
  }
}

async function readProjectTemplateId(projectPath: string): Promise<string | null> {
  try {
    const data = await loadProjectFile(projectPath);
    return data.script?.templateId ?? null;
  } catch {
    return null;
  }
}
