import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDouyinImportPaths,
  syncTranscriptToOriginal,
  writeImportResult,
  writePreviewMetadata,
  writeSourceMetadata,
  writeTranscriptMarkdown,
} from '../electron/video-import/transcript-writer';
import { createVideoImportService } from '../electron/video-import/import-service';
import { extractAudioToMp3 } from '../electron/video-import/media-extractor';
import { resolveDouyinVideoSource } from '../electron/video-import/douyin-downloader';
import {
  parseBcutResultPayload,
  transcribeWithBcut,
} from '../electron/video-import/bcut-asr';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-import-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('transcript writer', () => {
  it('builds douyin import paths in the project imports directory', () => {
    const paths = buildDouyinImportPaths('/tmp/demo', '123');

    expect(paths.importDir).toBe(path.join('/tmp/demo', 'imports', 'douyin', '123'));
    expect(paths.videoPath).toBe(path.join(paths.importDir, 'video.mp4'));
    expect(paths.audioPath).toBe(path.join(paths.importDir, 'audio.mp3'));
    expect(paths.transcriptSrtPath).toBe(path.join(paths.importDir, 'transcript.srt'));
    expect(paths.transcriptPath).toBe(path.join(paths.importDir, 'transcript.md'));
    expect(paths.sourceMetadataPath).toBe(path.join(paths.importDir, 'source.json'));
    expect(paths.resultMetadataPath).toBe(path.join(paths.importDir, 'import-result.json'));
    expect(paths.previewMetadataPath).toBe(path.join(paths.importDir, 'preview.json'));
  });

  it('writes transcript artifacts and syncs the original draft', async () => {
    const paths = buildDouyinImportPaths(tmpDir, '123');

    await writeSourceMetadata(paths, {
      sourceType: 'douyin',
      sourceUrl: 'https://v.douyin.com/demo',
      videoId: '123',
      title: '测试视频',
      resolvedPageUrl: 'https://www.douyin.com/video/123',
      downloadUrl: 'https://video.example.com/demo.mp4',
      importedAt: '2026-04-10T01:00:00.000Z',
    });
    await writeTranscriptMarkdown(paths, '第一段\n第二段', '1\n00:00:00,000 --> 00:00:01,000\n第一段\n');
    await syncTranscriptToOriginal(paths);
    await writeImportResult(paths, {
      importId: 'douyin_123',
      sourceType: 'douyin',
      videoId: '123',
      title: '测试视频',
      projectDir: tmpDir,
      importDir: paths.importDir,
      videoPath: paths.videoPath,
      audioPath: paths.audioPath,
      transcriptPath: paths.transcriptPath,
      transcriptSrtPath: paths.transcriptSrtPath,
      originalPath: paths.originalPath,
      sourceMetadataPath: paths.sourceMetadataPath,
      resultMetadataPath: paths.resultMetadataPath,
      previewMetadataPath: paths.previewMetadataPath,
      sourceUrl: 'https://v.douyin.com/demo',
      resolvedPageUrl: 'https://www.douyin.com/video/123',
      engine: 'bcut',
      syncedToOriginal: true,
      createdAt: '2026-04-10T01:00:00.000Z',
    });
    await writePreviewMetadata(paths, {
      schema: 'video-import-preview',
      version: 1,
      sourceType: 'douyin',
      title: '测试视频',
      videoId: '123',
      createdAt: '2026-04-10T01:00:00.000Z',
      syncedToOriginal: true,
      engine: 'bcut',
      projectDir: tmpDir,
      importDir: paths.importDir,
      media: {
        videoPath: paths.videoPath,
        audioPath: paths.audioPath,
      },
      transcript: {
        markdownPath: paths.transcriptPath,
        srtPath: paths.transcriptSrtPath,
        text: '第一段\n\n第二段',
        srtText: '1\n00:00:00,000 --> 00:00:01,000\n第一段\n',
        segments: [{ text: '第一段', startMs: 0, endMs: 1000 }],
      },
      metadata: {
        sourceUrl: 'https://v.douyin.com/demo',
        resolvedPageUrl: 'https://www.douyin.com/video/123',
        originalPath: paths.originalPath,
        sourceMetadataPath: paths.sourceMetadataPath,
        resultMetadataPath: paths.resultMetadataPath,
      },
    });

    await expect(fs.readFile(paths.transcriptPath, 'utf8')).resolves.toContain('第一段');
    await expect(fs.readFile(paths.transcriptSrtPath, 'utf8')).resolves.toContain('00:00:00,000');
    await expect(fs.readFile(paths.originalPath, 'utf8')).resolves.toContain('第二段');
    await expect(fs.readFile(paths.sourceMetadataPath, 'utf8')).resolves.toContain('测试视频');
    await expect(fs.readFile(paths.resultMetadataPath, 'utf8')).resolves.toContain('"engine": "bcut"');
    await expect(fs.readFile(paths.previewMetadataPath, 'utf8')).resolves.toContain('"schema": "video-import-preview"');
  });
});

describe('douyin downloader', () => {
  it('resolves video metadata from douyin render data', async () => {
    const renderData = encodeURIComponent(JSON.stringify({
      app: {
        videoInfoRes: {
          item_list: [
            {
              aweme_id: '1234567890',
              desc: '测试抖音视频',
              video: {
                play_addr: {
                  url_list: ['https://video.example.com/play.mp4'],
                },
                download_addr: {
                  url_list: ['https://video.example.com/download.mp4'],
                },
              },
            },
          ],
        },
      },
    }));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        `<html><script id="RENDER_DATA" type="application/json">${renderData}</script></html>`,
        { status: 200 },
      ),
    ));

    const result = await resolveDouyinVideoSource('https://v.douyin.com/demo');

    expect(result.videoId).toBe('1234567890');
    expect(result.title).toBe('测试抖音视频');
    expect(result.downloadUrl).toBe('https://video.example.com/download.mp4');
  });

  it('falls back to the mobile share page when desktop html has no render data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('<html><body></body><script>window.__broken__=true;</script></html>', {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `<html><script>window._data={"item_list":[{"aweme_id":"7626707636808879394","desc":"真实短链测试","video":{"play_addr":{"url_list":["https:\\/\\/aweme.snssdk.com\\/aweme\\/v1\\/playwm\\/?video_id=test123"]}}}]}</script></html>`,
          {
            status: 200,
          },
        ),
      );

    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveDouyinVideoSource('https://v.douyin.com/WWzVwSYKuFE/');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.videoId).toBe('7626707636808879394');
    expect(result.title).toBe('真实短链测试');
    expect(result.downloadUrl).toContain('/play/');
  });

  it('solves the Douyin WAF challenge before parsing the mobile share page', async () => {
    const challengePayload = Buffer.from(JSON.stringify({
      v: {
        a: Buffer.from('prefix').toString('base64'),
        b: 1777098214,
        c: Buffer.from(
          '2d6d3392580ddb560e9da949b258c273b3f53f8eccb33e07a75ddc6e137852a2',
          'hex',
        ).toString('base64'),
      },
      s: Buffer.from('salt').toString('base64'),
    })).toString('base64');
    const challengeHtml = `<html><script>var wci="_wafchallengeid",cs="${challengePayload}",c=JSON.parse(atob(cs));</script>Please wait...</html>`;
    const shareHtml = `<html>
      <link rel="canonical" href="https://www.douyin.com/video/7630804615994379535"/>
      <script>window._ROUTER_DATA={"loaderData":{"video":{"aweme_id":"7630804615994379535","desc":"WAF short link test","video":{"play_addr":{"url_list":["https:\\/\\/aweme.snssdk.com\\/aweme\\/v1\\/playwm\\/?video_id=test456"]}}}}}</script>
    </html>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(challengeHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(shareHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveDouyinVideoSource('https://v.douyin.com/eWaJkNygvrk/');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: expect.objectContaining({
        Cookie: expect.stringContaining('_wafchallengeid='),
      }),
    });
    expect(result.videoId).toBe('7630804615994379535');
    expect(result.title).toBe('WAF short link test');
    expect(result.downloadUrl).toContain('/play/');
  });
});

describe('media extractor', () => {
  it('returns the target mp3 path after ffmpeg succeeds', async () => {
    const calls: unknown[] = [];
    const output = await extractAudioToMp3('/tmp/demo/video.mp4', '/tmp/demo/audio.mp3', {
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    expect(output).toBe('/tmp/demo/audio.mp3');
    expect(calls).toHaveLength(1);
  });

  it('throws a clear error when ffmpeg is unavailable', async () => {
    await expect(
      extractAudioToMp3('/tmp/demo/video.mp4', '/tmp/demo/audio.mp3', {
        execFile: async () => {
          const error = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      }),
    ).rejects.toThrow('未找到 ffmpeg');
  });
});

describe('bcut asr', () => {
  it('parses bcut task payload into transcript result', () => {
    const payload = parseBcutResultPayload({
      utterances: [
        {
          transcript: '第一句',
          start_time: 0,
          end_time: 1000,
        },
        {
          transcript: '第二句',
          start_time: 1200,
          end_time: 2200,
        },
      ],
    });

    expect(payload.engine).toBe('bcut');
    expect(payload.fullText).toContain('第二句');
    expect(payload.srtText).toContain('00:00:00,000');
    expect(payload.segments[0]).toEqual({
      text: '第一句',
      startMs: 0,
      endMs: 1000,
    });
  });

  it('parses word-level timestamps when bcut returns words', () => {
    const payload = parseBcutResultPayload({
      utterances: [
        {
          transcript: '你好',
          start_time: 0,
          end_time: 600,
          words: [
            { label: '你', start_time: 0, end_time: 300 },
            { label: '好', start_time: 300, end_time: 600 },
            { label: ' ', start_time: 600, end_time: 600 },
          ],
        },
      ],
    });

    expect(payload.segments[0].words).toEqual([
      { text: '你', startMs: 0, endMs: 300 },
      { text: '好', startMs: 300, endMs: 600 },
    ]);
  });

  it('transcribes audio with the bcut http workflow in js', async () => {
    const audioPath = path.join(tmpDir, 'audio.mp3');
    await fs.writeFile(audioPath, 'audio-binary', 'utf8');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              in_boss_key: 'boss',
              resource_id: 'resource',
              upload_id: 'upload',
              upload_urls: ['https://upload.example.com/part-1'],
              per_size: 1024,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 200, headers: { Etag: 'etag-1' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              download_url: 'https://download.example.com/audio.mp3',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              task_id: 'task-1',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              state: 4,
              result: JSON.stringify({
                utterances: [
                  {
                    transcript: 'JS 识别成功',
                    start_time: 0,
                    end_time: 1500,
                  },
                ],
              }),
            },
          }),
          { status: 200 },
        ),
      );

    const result = await transcribeWithBcut(audioPath, {
      fetchImpl: fetchMock,
      sleep: async () => undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.engine).toBe('bcut');
    expect(result.fullText).toContain('JS 识别成功');
    expect(result.srtText).toContain('00:00:00,000 --> 00:00:01,500');
  });
});

describe('video import service', () => {
  it('imports douyin video artifacts and syncs original.md', async () => {
    const service = createVideoImportService({
      downloader: {
        resolveSource: async () => ({
          videoId: '9001',
          title: '导入测试',
          resolvedPageUrl: 'https://www.douyin.com/video/9001',
          downloadUrl: 'https://video.example.com/9001.mp4',
        }),
        downloadToPath: async (_url, targetPath) => {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, 'video-binary', 'utf8');
        },
      },
      mediaExtractor: {
        extractAudioToMp3: async (_videoPath, audioPath) => {
          await fs.writeFile(audioPath, 'audio-binary', 'utf8');
          return audioPath;
        },
      },
      asrRunner: {
        transcribe: async () => ({
          engine: 'bcut',
          fullText: '第一段\n第二段',
          srtText: '1\n00:00:00,000 --> 00:00:01,000\n第一段\n',
          segments: [
            { text: '第一段', startMs: 0, endMs: 1000 },
            { text: '第二段', startMs: 1000, endMs: 2000 },
          ],
        }),
      },
    });

    const result = await service.importVideoSource({
      sourceType: 'douyin',
      url: 'https://v.douyin.com/demo',
      projectDir: tmpDir,
      syncToOriginal: true,
    });

    expect(result.videoPath).toBe(path.join(tmpDir, 'imports', 'douyin', '9001', 'video.mp4'));
    expect(result.previewMetadataPath).toBe(
      path.join(tmpDir, 'imports', 'douyin', '9001', 'preview.json'),
    );
    await expect(fs.readFile(result.originalPath, 'utf8')).resolves.toContain('第一段');
    await expect(fs.readFile(result.sourceMetadataPath, 'utf8')).resolves.toContain('导入测试');
    await expect(fs.readFile(result.previewMetadataPath, 'utf8')).resolves.toContain('"segments"');

    const status = service.getImportStatus(result.importId);
    expect(status?.status).toBe('done');
    expect(status?.result?.transcriptPath).toBe(result.transcriptPath);
  });

  it('imports local video without using the douyin downloader', async () => {
    const localVideoPath = path.join(tmpDir, 'fixtures', 'clip.mp4');
    await fs.mkdir(path.dirname(localVideoPath), { recursive: true });
    await fs.writeFile(localVideoPath, 'video-binary', 'utf8');

    const resolveSource = vi.fn();
    const downloadToPath = vi.fn();
    const extractAudioToMp3 = vi.fn(async (_videoPath: string, audioPath: string) => {
      await fs.writeFile(audioPath, 'audio-binary', 'utf8');
      return audioPath;
    });
    const transcribe = vi.fn(async () => ({
      engine: 'bcut' as const,
      fullText: '本地视频第一段',
      srtText: '1\n00:00:00,000 --> 00:00:01,000\n本地视频第一段\n',
      segments: [{ text: '本地视频第一段', startMs: 0, endMs: 1000 }],
    }));

    const service = createVideoImportService({
      downloader: { resolveSource, downloadToPath },
      mediaExtractor: { extractAudioToMp3 },
      asrRunner: { transcribe },
      now: () => new Date('2026-04-10T00:00:00.000Z'),
    });

    const result = await service.importVideoSource({
      sourceType: 'local_video',
      filePath: localVideoPath,
      projectDir: tmpDir,
      syncToOriginal: true,
    });

    expect(resolveSource).not.toHaveBeenCalled();
    expect(downloadToPath).not.toHaveBeenCalled();
    expect(extractAudioToMp3).toHaveBeenCalledWith(result.videoPath, result.audioPath);
    expect(transcribe).toHaveBeenCalledWith(result.audioPath);
    expect(result.sourceType).toBe('local_video');
    expect(result.importDir).toContain(path.join('imports', 'local_video'));
    expect(result.sourcePath).toBe(localVideoPath);
    await expect(fs.readFile(result.sourceMetadataPath, 'utf8')).resolves.toContain('"sourceType": "local_video"');
    await expect(fs.readFile(result.previewMetadataPath, 'utf8')).resolves.toContain('"sourcePath"');
  });

  it('imports local audio by converting it to mp3 before transcription', async () => {
    const localAudioPath = path.join(tmpDir, 'fixtures', 'voice.wav');
    await fs.mkdir(path.dirname(localAudioPath), { recursive: true });
    await fs.writeFile(localAudioPath, 'audio-binary', 'utf8');

    const resolveSource = vi.fn();
    const downloadToPath = vi.fn();
    const extractAudioToMp3 = vi.fn();
    const convertAudioToMp3 = vi.fn(async (_sourceAudioPath: string, audioPath: string) => {
      await fs.writeFile(audioPath, 'converted-audio', 'utf8');
      return audioPath;
    });
    const transcribe = vi.fn(async () => ({
      engine: 'bcut' as const,
      fullText: '本地音频第一段',
      srtText: '1\n00:00:00,000 --> 00:00:01,000\n本地音频第一段\n',
      segments: [{ text: '本地音频第一段', startMs: 0, endMs: 1000 }],
    }));

    const service = createVideoImportService({
      downloader: { resolveSource, downloadToPath },
      mediaExtractor: { extractAudioToMp3, convertAudioToMp3 },
      asrRunner: { transcribe },
      now: () => new Date('2026-04-10T00:00:00.000Z'),
    });

    const result = await service.importVideoSource({
      sourceType: 'local_audio',
      filePath: localAudioPath,
      projectDir: tmpDir,
      syncToOriginal: true,
    });

    expect(resolveSource).not.toHaveBeenCalled();
    expect(downloadToPath).not.toHaveBeenCalled();
    expect(extractAudioToMp3).not.toHaveBeenCalled();
    expect(convertAudioToMp3).toHaveBeenCalledWith(localAudioPath, result.audioPath);
    expect(transcribe).toHaveBeenCalledWith(result.audioPath);
    expect(result.sourceType).toBe('local_audio');
    expect(result.importDir).toContain(path.join('imports', 'local_audio'));
    expect(result.sourcePath).toBe(localAudioPath);
    await expect(fs.readFile(result.originalPath, 'utf8')).resolves.toContain('本地音频第一段');
    await expect(fs.readFile(result.previewMetadataPath, 'utf8')).resolves.toContain('"sourceType": "local_audio"');
  });
});
