import { useCallback, useEffect, useState } from 'react';
import type { LingjiAccount } from '../../lib/electron-api';
import type { LLMProvider } from '../../types/ai';
import {
  applyLingjiFallbackProviders,
  buildLingjiLlmProvider,
  clearLingjiProviderKeys,
} from '../../lib/llm/lingji-gateway';
import { buildDefaultAISettings, loadAISettings, saveAISettings } from '../../store/ai';
import { Button } from '../../ui';

/**
 * 设置页灵机剪影账户区：未登录一键浏览器授权登录（服务器基址烘焙进包、不可见改）；
 * 已登录显示账号/积分并提供退出（退出保留托管 Provider、清空失效 lj_ key）。
 */
export function LingjiGatewayConnect({
  onConnected,
}: {
  onConnected: (provider: LLMProvider) => void;
}) {
  const [account, setAccount] = useState<LingjiAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.lingjiGetAccount().then(setAccount).catch(() => undefined);
  }, []);

  const login = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { session, base } = await window.electronAPI.lingjiLogin();
      const settings = (await loadAISettings()) ?? buildDefaultAISettings();
      await saveAISettings(applyLingjiFallbackProviders(settings, session, base));
      onConnected(buildLingjiLlmProvider(session, base));
      setAccount(await window.electronAPI.lingjiGetAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }, [onConnected]);

  const logout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.lingjiLogout();
      const settings = await loadAISettings();
      if (settings) await saveAISettings(clearLingjiProviderKeys(settings));
      setAccount(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败');
    } finally {
      setLoading(false);
    }
  }, []);

  if (account) {
    return (
      <>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #86868b)' }}>
          已登录：{account.email} · {account.balance} 积分
        </span>
        <Button type="button" variant="secondary" onClick={logout} disabled={loading}>
          {loading ? '处理中…' : '退出登录'}
        </Button>
        {error && (
          <span style={{ color: 'var(--color-system-red, #ff3b30)', fontSize: 12 }}>{error}</span>
        )}
      </>
    );
  }

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
