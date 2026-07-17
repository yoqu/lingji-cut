// src/lib/script-review.ts
import type { AISettings, PromptBindingMap } from '../types/ai';
import { generateStructuredData, streamTextWithProvider, parseLLMJsonResponse } from './llm';
import { resolvePromptBinding } from './llm/binding-resolver';
import { renderTemplate, renderUserPromptWithLock, type PromptTemplate } from './prompts';
import type { Annotation, AnnotationSeverity } from '../store/script';

interface RawAnnotation {
  originalText?: string;
  issue?: string;
  suggestion?: string;
  severity?: string;
}

function isValidSeverity(value: unknown): value is AnnotationSeverity {
  return value === 'error' || value === 'warning' || value === 'info';
}

export function parseAnnotations(payload: unknown, scriptText: string): Annotation[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { annotations?: unknown[] }).annotations)) {
    return [];
  }

  const annotations: Annotation[] = [];
  let counter = 0;

  for (const raw of (payload as { annotations: RawAnnotation[] }).annotations) {
    if (!raw.originalText || !raw.issue || !raw.suggestion) continue;
    if (!isValidSeverity(raw.severity)) continue;

    const startOffset = scriptText.indexOf(raw.originalText);
    if (startOffset === -1) continue;

    counter += 1;
    annotations.push({
      id: `ann-${counter}`,
      startOffset,
      endOffset: startOffset + raw.originalText.length,
      originalText: raw.originalText,
      quotedText: raw.originalText,
      docVersion: 0,
      issue: raw.issue,
      suggestion: raw.suggestion,
      severity: raw.severity,
      status: 'pending',
    });
  }

  return annotations;
}

function buildMessages(template: PromptTemplate, scriptText: string): {
  systemPrompt: string;
  userMessage: string;
} {
  const systemPrompt = renderTemplate(template.system ?? '', { scriptText });
  const userMessage = renderUserPromptWithLock('script.review', template, { scriptText });
  return { systemPrompt, userMessage };
}

export async function reviewScript(
  settings: AISettings,
  projectBindings: PromptBindingMap | null,
  template: PromptTemplate,
  scriptText: string,
): Promise<Annotation[]> {
  const binding = resolvePromptBinding('script.review', settings, projectBindings);
  const { systemPrompt, userMessage } = buildMessages(template, scriptText);
  const payload = await generateStructuredData(settings, systemPrompt, userMessage, binding);
  return parseAnnotations(payload, scriptText);
}

export interface ScriptReviewStreamOptions {
  onChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export async function reviewScriptStream(
  settings: AISettings,
  projectBindings: PromptBindingMap | null,
  template: PromptTemplate,
  scriptText: string,
  options: ScriptReviewStreamOptions = {},
): Promise<Annotation[]> {
  const binding = resolvePromptBinding('script.review', settings, projectBindings);
  const { systemPrompt, userMessage } = buildMessages(template, scriptText);

  const fullText = await streamTextWithProvider(
    binding.provider,
    binding.model,
    systemPrompt,
    userMessage,
    options.onChunk ?? (() => {}),
    { onReasoningChunk: options.onReasoningChunk, signal: options.signal },
  );

  const payload = parseLLMJsonResponse(fullText);
  return parseAnnotations(payload, scriptText);
}
