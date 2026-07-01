import { useState } from 'react';
import type { LLMProvider } from '../../types/ai';
import {
  applyLingjiFallbackProviders,
  buildLingjiLlmProvider,
} from '../../lib/llm/lingji-gateway';
import { buildDefaultAISettings, loadAISettings, saveAISettings } from '../../store/ai';
import { Button } from '../../ui';

/**
 * 一键登录灵机剪影账户（浏览器授权，服务器基址烘焙进包、不可见改）：
 * 登录后自动 upsert 四类兜底 Provider，并回填对话 Provider 到设置页编辑态。
 */
export function LingjiGatewayConnect({
  onConnected,
}: {
  onConnected: (provider: LLMProvider) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    setLoading(true);
    setError(null);
    try {
      const { session, base } = await window.electronAPI.lingjiLogin();
      const settings = (await loadAISettings()) ?? buildDefaultAISettings();
      await saveAISettings(applyLingjiFallbackProviders(settings, session, base));
      onConnected(buildLingjiLlmProvider(session, base));
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button type="button" variant="secondary" onClick={login} disabled={loading}>
        {loading ? '授权中…' : '一键登录灵机剪影'}
      </Button>
      {error && (
        <span style={{ color: 'var(--color-system-red, #ff3b30)', fontSize: 12 }}>{error}</span>
      )}
    </>
  );
}
