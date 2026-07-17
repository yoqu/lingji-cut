import type { AISettings } from '../types/ai';

export function getAISettingsIssue(settings: AISettings | null): string | null {
  if (!settings) {
    return '请先完成 AI 配置后再开始分析';
  }

  const provider = settings.llmProviders?.find((item) => item.id === settings.defaultProviderId)
    ?? settings.llmProviders?.[0];
  if (!provider) {
    return '请先配置文本生成服务';
  }
  if (!settings.defaultModel && provider.models.length === 0) {
    return '请先填写模型名称';
  }
  return null;
}
