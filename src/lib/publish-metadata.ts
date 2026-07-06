// 发布文案（标题 / 描述 / 标签）的 AI 一键生成。
// 提示词走配置中心（kind: publish.metadata），主进程加载 effective 模板 + 解析
// 每提示词模型绑定后调用 generateStructuredData（与封面提示词重生成同源）。

import type { AISettings } from '../types/ai';
import { generateStructuredData } from './llm';
import type { ResolvedBinding } from './llm/binding-resolver';
import { renderUserPromptWithLock, type PromptTemplate } from './prompts';

/** buildMetadataSource 接受的最小结构：AIAnalysisResult 与 planning 结果均满足。 */
export interface MetadataSourceInput {
  summary?: string;
  keywords?: string[];
  segments?: Array<{ title: string; summary?: string }>;
}

/** 拼接 AI 分析摘要 / 关键词 / 段落，兜底用字幕原文，作为发布文案生成素材。 */
export function buildMetadataSource(analysis: MetadataSourceInput | null, srtText: string): string {
  const parts: string[] = [];
  if (analysis?.summary) parts.push(`节目总结：${analysis.summary}`);
  if (analysis?.keywords?.length) parts.push(`关键词：${analysis.keywords.join('、')}`);
  if (analysis?.segments?.length) {
    const segs = analysis.segments
      .slice(0, 16)
      .map((s, i) => `${i + 1}. ${s.title}${s.summary ? `：${s.summary}` : ''}`)
      .join('\n');
    parts.push(`段落概要：\n${segs}`);
  }
  if (parts.length === 0 && srtText.trim()) {
    parts.push(`字幕内容：${srtText.trim().slice(0, 3000)}`);
  }
  return parts.join('\n\n');
}

export interface PublishMetadataInput {
  /** 节目内容素材：摘要 / 关键词 / 字幕摘录拼接而成。 */
  sourceText: string;
  /** 当前已填标题，作为风格参考（可空）。 */
  currentTitle?: string;
}

export interface PublishMetadata {
  title: string;
  desc: string;
  tags: string[];
}

/** 把输入素材拼成"内容消息"（节目内容 + 可选的已有标题参考）。 */
function buildPublishMetadataContent(input: PublishMetadataInput): string {
  const parts: string[] = [];
  if (input.currentTitle?.trim()) {
    parts.push(`【已有标题，可参考其风格，但不要照抄】\n${input.currentTitle.trim()}`);
  }
  parts.push(`【节目内容】\n${input.sourceText.trim()}`);
  return parts.join('\n\n');
}

/**
 * 渲染 system / user 两段消息：
 * - systemPrompt：配置中心可编辑的约束规则（user 段）+ 末尾自动拼接的 JSON 输出契约；
 * - userMessage：本次请求的节目内容（与可选的已有标题），由系统注入，不在模板里。
 * 与 planning.segment 同构：规则进 system 位，数据进 user 位。
 */
export function buildPublishMetadataMessages(
  template: PromptTemplate,
  input: PublishMetadataInput,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt = renderUserPromptWithLock('publish.metadata', template, {});
  const userMessage = buildPublishMetadataContent(input);
  return { systemPrompt, userMessage };
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceTags(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、\s]+/)
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().replace(/^#+/, '').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    tags.push(cleaned);
  }
  return tags.slice(0, 12);
}

export function parsePublishMetadata(payload: Record<string, unknown>): PublishMetadata {
  const title = coerceString(payload.title);
  const desc = coerceString(payload.desc ?? payload.description);
  const tags = coerceTags(payload.tags ?? payload.keywords);
  if (!title && !desc && tags.length === 0) {
    throw new Error('LLM 未返回有效的发布文案');
  }
  return { title, desc, tags };
}

export interface GeneratePublishMetadataOptions {
  /** 配置中心解析出的 effective 模板（publish.metadata）。 */
  template: PromptTemplate;
  /** 每提示词模型绑定；缺省时 generateStructuredData 回退到全局默认 LLM。 */
  binding?: ResolvedBinding;
  /** 注入点：默认使用 generateStructuredData，测试可替换。 */
  generateStructuredData?: typeof generateStructuredData;
}

export async function generatePublishMetadata(
  settings: AISettings,
  input: PublishMetadataInput,
  options: GeneratePublishMetadataOptions,
): Promise<PublishMetadata> {
  if (!input.sourceText.trim()) {
    throw new Error('没有可用于生成文案的节目内容');
  }
  if (!options.template) {
    throw new Error('缺少发布文案提示词模板');
  }
  const generate = options.generateStructuredData ?? generateStructuredData;
  const { systemPrompt, userMessage } = buildPublishMetadataMessages(options.template, input);
  const payload = await generate(settings, systemPrompt, userMessage, options.binding, {
    label: 'publish-metadata',
  });
  return parsePublishMetadata(payload);
}
