import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildMetadataSource,
  generatePublishMetadata,
} from '../../../src/lib/publish-metadata';
import { resolvePromptBinding } from '../../../src/lib/llm/binding-resolver';
import {
  extractMetaSection,
  extractPublishSection,
  resolveWorkTitle,
} from '../../../src/lib/project-persistence';
import { parseSrt } from '../../../src/lib/srt-parser';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import { HeadlessProjectContext } from '../context';
import { loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile } from '../../project-file';
import type { GenerationRunCtx } from '../headless-generation';

interface MetadataDeps {
  generate?: typeof generatePublishMetadata;
}

/**
 * 生成作品标题与发布文案，落盘 meta.title（真源）+ publish 段（title 镜像，desc/tags 只填空）。
 * 默认 fill-if-empty：已有标题（resolveWorkTitle 非空）时跳过；params.force 强制重生成。
 */
export async function runPublishMetadataHeadless(
  ctx: GenerationRunCtx,
  deps: MetadataDeps = {},
): Promise<{ skipped: boolean; title: string }> {
  const generate = deps.generate ?? generatePublishMetadata;
  const { projectPath, userDataPath, handle, params } = ctx;
  const force = params?.force === true;

  handle.update({ phase: '装配设置', percent: 10 });
  const project = await loadProjectFile(projectPath);
  const existingTitle = resolveWorkTitle(project);
  if (existingTitle && !force) {
    handle.update({ phase: '已有标题，跳过', percent: 100 });
    return { skipped: true, title: existingTitle };
  }

  const analysisResult = project.aiAnalysis?.analysisResult ?? null;
  let srtText = '';
  try {
    const srt = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
    srtText = parseSrt(srt)
      .map((e) => e.text)
      .join(' ');
  } catch {
    // 无字幕时仅依赖分析结果
  }
  const sourceText = buildMetadataSource(analysisResult, srtText);
  if (!sourceText.trim()) {
    throw new GenerationError('no_source', '没有可用于生成文案的内容，请先运行字幕分析或生成字幕。');
  }

  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const template = await loadEffectivePromptTemplate('publish.metadata', {
    userDataPath,
    projectDir: projectPath,
  });
  const binding = resolvePromptBinding('publish.metadata', settings, projectBindings);

  handle.update({ phase: '生成文案', percent: 40 });
  const md = await generate(
    settings,
    { sourceText, currentTitle: existingTitle || undefined },
    { template, binding },
  );

  handle.update({ phase: '写入', percent: 90 });
  const headless = new HeadlessProjectContext(projectPath);
  await headless.saveSection('meta', { ...extractMetaSection(project), title: md.title });
  const publish = extractPublishSection(project);
  await headless.saveSection('publish', {
    ...publish,
    title: md.title,
    desc: publish.desc || md.desc,
    tagsInput: publish.tagsInput || md.tags.join(', '),
  });
  handle.update({ phase: '完成', percent: 100 });
  return { skipped: false, title: md.title };
}
