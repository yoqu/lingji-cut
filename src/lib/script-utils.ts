/**
 * 口播稿工作台共用工具函数
 * 从旧 Step 组件中提取，供 ScriptWorkbench 及后续 Agent 流程复用。
 */

import { generateText, streamText } from './llm';
import type { PromptBindingMap } from '../types/ai';
import { reviewScript, reviewScriptStream } from './script-review';
import { loadAISettings, useAIStore } from '../store/ai';
import { getProjectDir } from '../store/timeline';
import { renderTemplate, type PromptTemplate } from './prompts';
import { SCRIPT_TEMPLATE_SEEDS } from './prompts/script-template-defaults';
import type { UserPromptEntry } from './prompts/types';
import { resolveUserPromptBinding } from './llm/binding-resolver';
import { getRoleById } from './script-templates';
import type { Annotation } from '../store/script';
import type { AISettings } from '../types/ai';

// --- 原稿统计 ---

export interface OriginalStats {
  charCount: number;
  paragraphs: number;
  readMinutes: number;
}

export function getOriginalStats(text: string): OriginalStats {
  const charCount = text.length;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  const readMinutes = Math.max(1, Math.ceil(charCount / 400));
  return { charCount, paragraphs, readMinutes };
}

// --- 生成稿统计 ---

export interface GeneratedScriptStats {
  charCount: number;
  readMinutes: number;
}

export function getGeneratedScriptStats(text: string): GeneratedScriptStats {
  return {
    charCount: text.length,
    readMinutes: Math.max(1, Math.ceil(text.length / 300)),
  };
}

// --- 批注摘要 ---

export interface AnnotationSummary {
  total: number;
  pending: number;
  accepted: number;
  dismissed: number;
}

export function getAnnotationSummary(annotations: Annotation[]): AnnotationSummary {
  return annotations.reduce<AnnotationSummary>(
    (summary, annotation) => {
      summary.total += 1;
      summary[annotation.status] += 1;
      return summary;
    },
    { total: 0, pending: 0, accepted: 0, dismissed: 0 },
  );
}

// --- 最终稿摘要 ---

export interface FinalScriptSummary {
  charCount: number;
  paragraphCount: number;
}

export function getFinalScriptSummary(text: string): FinalScriptSummary {
  return {
    charCount: text.length,
    paragraphCount: text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length,
  };
}

// --- AI 生成 ---

/**
 * 从 AIStore 的 userPromptEntries['script-template'] 读取指定模板的原始条目。
 * Store 未 hydrate 时 fallback 到 SCRIPT_TEMPLATE_SEEDS，保证测试 / mock 环境也能工作。
 */
function getScriptTemplateEntry(templateId: string): UserPromptEntry | undefined {
  const entries = useAIStore.getState().userPromptEntries?.['script-template'] ?? [];
  const fromStore = entries.find((e) => e.id === templateId);
  if (fromStore) return fromStore;

  const seed = SCRIPT_TEMPLATE_SEEDS.find((s) => s.id === templateId);
  if (!seed) return undefined;
  return {
    id: seed.id,
    category: seed.category,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    system: seed.system,
    user: seed.user,
    isBuiltin: true,
  };
}

/**
 * 根据口播模板与角色构造最终的 system / user prompt。
 * user 段通过 `renderTemplate` 注入 `{{rawText}}` 变量（原始素材）。
 */
function buildScriptDraftPrompt(
  originalText: string,
  templateId: string,
  roleId: string | undefined,
): { systemPrompt: string; userPrompt: string } {
  const entry = getScriptTemplateEntry(templateId);
  if (!entry) {
    throw new Error('未找到选中的写稿模板');
  }

  let systemPrompt = entry.system;
  if (roleId && roleId !== 'none') {
    const role = getRoleById(roleId);
    if (role?.rolePrompt) {
      systemPrompt = `【角色设定】\n${role.rolePrompt}\n\n【写作要求】\n${systemPrompt}`;
    }
  }

  // user 段走 renderTemplate：如果模板为 `{{rawText}}` 则替换为原文，
  // 其他变量占位符若存在也能自然生效；未声明变量会被替换成空串。
  const userPrompt = renderTemplate(entry.user, { rawText: originalText });

  return { systemPrompt, userPrompt };
}

/**
 * 统一从 AIStore + AISettings 中解析某个口播模板在当前项目下的 LLM 绑定。
 * 优先：项目级模板绑定 → 全局默认 LLM。
 */
function resolveTemplateBinding(
  settings: AISettings,
  templateId: string,
): { provider: ReturnType<typeof resolveUserPromptBinding>['provider']; model: string } {
  const projectBindings = useAIStore.getState().projectBindings;
  return resolveUserPromptBinding('script-template', templateId, settings, projectBindings);
}

export async function generateScriptDraft(
  originalText: string,
  templateId: string,
  roleId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { systemPrompt, userPrompt } = buildScriptDraftPrompt(originalText, templateId, roleId);

  const settings = await loadAISettings();
  if (!settings) throw new Error('请先在 AI 设置中配置 LLM');

  const binding = resolveTemplateBinding(settings, templateId);
  return generateText(settings, systemPrompt, userPrompt, binding, signal);
}

/**
 * 流式生成口播稿草稿，逐 token 回调
 * @param onChunk 每收到一个 token 片段时调用
 * @returns 完整生成文本
 */
export async function generateScriptDraftStream(
  originalText: string,
  templateId: string,
  roleId: string | undefined,
  onChunk: (chunk: string) => void,
  options?: {
    onReasoningChunk?: (chunk: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const { systemPrompt, userPrompt } = buildScriptDraftPrompt(originalText, templateId, roleId);

  const settings = await loadAISettings();
  if (!settings) throw new Error('请先在 AI 设置中配置 LLM');

  const binding = resolveTemplateBinding(settings, templateId);
  return streamText(settings, systemPrompt, userPrompt, onChunk, options, binding, options?.signal);
}

// --- AI 审查 ---

interface ScriptReviewContext {
  settings: AISettings;
  projectBindings: PromptBindingMap | null;
  template: PromptTemplate;
}

async function loadScriptReviewContext(): Promise<ScriptReviewContext> {
  const settings = await loadAISettings();
  if (!settings) throw new Error('请先在 AI 设置中配置 LLM');

  const projectDir = getProjectDir();
  const projectBindings = useAIStore.getState().projectBindings;

  const effective = await window.electronAPI.readEffectivePrompt({
    kind: 'script.review',
    projectDir: projectDir || undefined,
  });
  const template: PromptTemplate = {
    name: effective.name,
    description: effective.description,
    version: effective.version,
    system: effective.system,
    user: effective.user,
  };

  return { settings, projectBindings, template };
}

export async function runScriptReview(scriptText: string): Promise<Annotation[]> {
  const ctx = await loadScriptReviewContext();
  return reviewScript(ctx.settings, ctx.projectBindings, ctx.template, scriptText);
}

/**
 * 流式审稿：逐 token 回调（用于驱动审稿动画），最终解析并返回批注列表
 */
export async function runScriptReviewStream(
  scriptText: string,
  onChunk: (chunk: string) => void,
  options?: { onReasoningChunk?: (chunk: string) => void; signal?: AbortSignal },
): Promise<Annotation[]> {
  const ctx = await loadScriptReviewContext();
  return reviewScriptStream(ctx.settings, ctx.projectBindings, ctx.template, scriptText, {
    onChunk,
    onReasoningChunk: options?.onReasoningChunk,
    signal: options?.signal,
  });
}
