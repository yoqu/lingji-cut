import fs from 'node:fs/promises';
import path from 'node:path';
import { readTextIfExists, readTextIfExistsSync } from './fs-utils';
import {
  DEFAULT_PROMPT_YAML,
  PROMPT_KINDS,
  createPromptYamlFromUserText,
  getBuiltinPromptTemplate,
  parsePromptYaml,
  type EffectivePromptTemplate,
  type PromptKind,
  type PromptScope,
  type PromptTemplate,
} from '../src/lib/prompts';

const GLOBAL_SUBDIR = 'prompts';
const PROJECT_SUBDIR = path.join('configs', 'prompts');

function kindToRelativePath(kind: PromptKind): string {
  return `${kind.replace(/\./g, path.sep)}.yaml`;
}

function globalPromptFilePath(userDataPath: string, kind: PromptKind): string {
  return path.join(userDataPath, GLOBAL_SUBDIR, kindToRelativePath(kind));
}

function projectPromptFilePath(projectDir: string, kind: PromptKind): string {
  return path.join(projectDir, PROJECT_SUBDIR, kindToRelativePath(kind));
}

/**
 * 解析覆盖文件并做版本门槛：覆盖的 version 低于内置模板 version 视为过旧（占位符
 * 集合可能已不兼容，如 cards.segment v19 的 {{presetMotionTokens}}），跳过该层。
 * 无 version 的手写覆盖不参与比较，保持生效。
 */
function parseUsableOverride(raw: string, kind: PromptKind, scopeLabel: string): PromptTemplate | null {
  let template: PromptTemplate;
  try {
    template = parsePromptYaml(raw, kind).template;
  } catch (err) {
    console.warn(`[prompts] ${scopeLabel} ${kind} YAML 解析失败，跳过该覆盖：`, err);
    return null;
  }
  const builtinVersion = getBuiltinPromptTemplate(kind).version;
  const compatibleCoverV8 = kind === 'cover.regeneration'
    && template.version === 8
    && builtinVersion === 9;
  if (
    typeof template.version === 'number' &&
    typeof builtinVersion === 'number' &&
    template.version < builtinVersion &&
    !compatibleCoverV8
  ) {
    console.warn(
      `[prompts] ${scopeLabel} ${kind} 覆盖版本过旧（v${template.version} < 内置 v${builtinVersion}），跳过该覆盖；如需继续自定义，请在设置页基于新版重新保存`,
    );
    return null;
  }
  if (compatibleCoverV8) {
    template = { ...template, version: builtinVersion };
  }
  return template;
}


export async function readRawPromptYaml(
  scope: PromptScope,
  kind: PromptKind,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<string | null> {
  if (scope === 'builtin') return DEFAULT_PROMPT_YAML[kind];
  if (scope === 'global') return readTextIfExists(globalPromptFilePath(ctx.userDataPath, kind));
  if (scope === 'project') {
    if (!ctx.projectDir) return null;
    return readTextIfExists(projectPromptFilePath(ctx.projectDir, kind));
  }
  return null;
}

export async function readPromptUserText(
  scope: PromptScope,
  kind: PromptKind,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<string | null> {
  const raw = await readRawPromptYaml(scope, kind, ctx);
  if (!raw || !raw.trim()) return null;
  try {
    const { template } = parsePromptYaml(raw, kind);
    return template.user;
  } catch {
    return null;
  }
}

export async function writePromptYaml(
  scope: 'global' | 'project',
  kind: PromptKind,
  content: string,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<string> {
  const filePath =
    scope === 'global'
      ? globalPromptFilePath(ctx.userDataPath, kind)
      : (() => {
          if (!ctx.projectDir) throw new Error('项目级提示词写入需要 projectDir');
          return projectPromptFilePath(ctx.projectDir, kind);
        })();

  // 先校验 YAML 与必要字段
  parsePromptYaml(content, kind);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

export async function writePromptUserText(
  scope: 'global' | 'project',
  kind: PromptKind,
  userText: string,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<string> {
  const currentRaw = await readRawPromptYaml(scope, kind, ctx);
  const builtin = getBuiltinPromptTemplate(kind);
  let base = builtin;
  if (currentRaw && currentRaw.trim()) {
    try {
      base = parsePromptYaml(currentRaw, kind).template;
    } catch {
      // 覆盖文件可能是用户过去手写坏的 YAML；纯文本保存时用内置元数据重建。
    }
  }
  // 主动保存视为基于当前内置版本的选择：version 至少提到内置版本，
  // 否则旧覆盖（version 过旧被 loader 跳过）重新保存后仍不生效。
  if (
    typeof builtin.version === 'number' &&
    (typeof base.version !== 'number' || base.version < builtin.version)
  ) {
    base = { ...base, version: builtin.version };
  }
  const content = createPromptYamlFromUserText(base, userText);
  return writePromptYaml(scope, kind, content, ctx);
}

export async function deletePromptYaml(
  scope: 'global' | 'project',
  kind: PromptKind,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<boolean> {
  const filePath =
    scope === 'global'
      ? globalPromptFilePath(ctx.userDataPath, kind)
      : (() => {
          if (!ctx.projectDir) throw new Error('项目级提示词删除需要 projectDir');
          return projectPromptFilePath(ctx.projectDir, kind);
        })();

  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function loadEffectivePromptTemplate(
  kind: PromptKind,
  ctx: { userDataPath: string; projectDir?: string },
): Promise<EffectivePromptTemplate> {
  // project > global > builtin；解析失败或版本过旧的覆盖跳过该层
  if (ctx.projectDir) {
    const projectRaw = await readTextIfExists(projectPromptFilePath(ctx.projectDir, kind));
    if (projectRaw && projectRaw.trim()) {
      const template = parseUsableOverride(projectRaw, kind, '项目级');
      if (template) return { ...template, sourceScope: 'project' };
    }
  }

  const globalRaw = await readTextIfExists(globalPromptFilePath(ctx.userDataPath, kind));
  if (globalRaw && globalRaw.trim()) {
    const template = parseUsableOverride(globalRaw, kind, '全局');
    if (template) return { ...template, sourceScope: 'global' };
  }

  return { ...getBuiltinPromptTemplate(kind), sourceScope: 'builtin' };
}

/** 卡片生成各入口共用的 cards.segment + card.image + cards.animation 三模板装载。 */
export async function loadCardTemplates(ctx: { userDataPath: string; projectDir?: string }): Promise<{
  cardTemplate: EffectivePromptTemplate;
  imageTemplate: EffectivePromptTemplate;
  animationTemplate: EffectivePromptTemplate;
}> {
  const [cardTemplate, imageTemplate, animationTemplate] = await Promise.all([
    loadEffectivePromptTemplate('cards.segment', ctx),
    loadEffectivePromptTemplate('card.image', ctx),
    loadEffectivePromptTemplate('cards.animation', ctx),
  ]);
  return { cardTemplate, imageTemplate, animationTemplate };
}

export function loadEffectivePromptTemplateSync(
  kind: PromptKind,
  ctx: { userDataPath: string; projectDir?: string },
): EffectivePromptTemplate {
  if (ctx.projectDir) {
    const projectRaw = readTextIfExistsSync(projectPromptFilePath(ctx.projectDir, kind));
    if (projectRaw && projectRaw.trim()) {
      const template = parseUsableOverride(projectRaw, kind, '项目级');
      if (template) return { ...template, sourceScope: 'project' };
    }
  }
  const globalRaw = readTextIfExistsSync(globalPromptFilePath(ctx.userDataPath, kind));
  if (globalRaw && globalRaw.trim()) {
    const template = parseUsableOverride(globalRaw, kind, '全局');
    if (template) return { ...template, sourceScope: 'global' };
  }
  return { ...getBuiltinPromptTemplate(kind), sourceScope: 'builtin' };
}

export interface PromptKindOverview {
  kind: PromptKind;
  effectiveScope: PromptScope;
  hasGlobal: boolean;
  hasProject: boolean;
}

export async function listPromptOverview(
  ctx: { userDataPath: string; projectDir?: string },
): Promise<PromptKindOverview[]> {
  const result: PromptKindOverview[] = [];
  for (const kind of PROMPT_KINDS) {
    const globalRaw = await readTextIfExists(globalPromptFilePath(ctx.userDataPath, kind));
    const projectRaw = ctx.projectDir
      ? await readTextIfExists(projectPromptFilePath(ctx.projectDir, kind))
      : null;
    const hasGlobal = Boolean(globalRaw);
    const hasProject = Boolean(projectRaw);
    // effectiveScope 与 loadEffectivePromptTemplate 同判据（解析失败/版本过旧的覆盖不算生效）
    const effectiveScope: PromptScope =
      projectRaw?.trim() && parseUsableOverride(projectRaw, kind, '项目级')
        ? 'project'
        : globalRaw?.trim() && parseUsableOverride(globalRaw, kind, '全局')
          ? 'global'
          : 'builtin';
    result.push({ kind, effectiveScope, hasGlobal, hasProject });
  }
  return result;
}

export type { PromptTemplate };
