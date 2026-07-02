import { useCallback, useEffect, useState } from 'react';
import { LogIn, User } from 'lucide-react';
import type { LingjiAccount } from '../../lib/electron-api';
import {
  applyLingjiFallbackProviders,
  clearLingjiProviderKeys,
  type LingjiSession,
} from '../../lib/llm/lingji-gateway';
import { buildDefaultAISettings, loadAISettings, saveAISettings } from '../../store/ai';
import styles from './AccountBadge.module.css';

/** 用会话（含服务端下发配置）重建四类托管 Provider 并落盘。 */
async function applySession(session: LingjiSession, base: string): Promise<void> {
  const settings = (await loadAISettings()) ?? buildDefaultAISettings();
  await saveAISettings(applyLingjiFallbackProviders(settings, session, base));
}

/**
 * 欢迎页账号面板：未登录显示浏览器授权登录入口；登录后展示邮箱/积分/会员档位与退出。
 * 登录成功自动配置四类托管 Provider；启动时从统一网关刷新下发配置并回灌（地址/模型由服务端下发，用户不可编辑）。
 */
export function AccountBadge() {
  const [account, setAccount] = useState<LingjiAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 刷新余额/tier 与服务端下发配置并回灌托管 Provider；key 失效时提示重新登录。 */
  const refreshAccount = useCallback(async () => {
    try {
      const refreshed = await window.electronAPI.lingjiRefreshConfig();
      if (refreshed?.expired) {
        setError('登录已失效，请退出后重新登录');
      } else if (refreshed) {
        await applySession(refreshed.session, refreshed.base);
        setError(null);
      }
    } catch {
      /* 离线/失败静默，沿用本地缓存 */
    }
    await window.electronAPI.lingjiGetAccount().then(setAccount).catch(() => undefined);
  }, []);

  useEffect(() => {
    // 启动时用缓存账户拉取最新下发配置，重建托管 Provider，保证配置始终以服务端为准。
    void refreshAccount();
  }, [refreshAccount]);

  /** 展开面板时刷新（消耗积分后保持面板数字为准）；副作用放在 updater 之外保持纯函数。 */
  const toggleMenu = useCallback(() => {
    const next = !menuOpen;
    if (next) void refreshAccount();
    setMenuOpen(next);
  }, [menuOpen, refreshAccount]);

  const login = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { session, base } = await window.electronAPI.lingjiLogin();
      await applySession(session, base);
      setAccount(await window.electronAPI.lingjiGetAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.lingjiLogout();
    try {
      // 托管 provider 保留（不动用户默认选择），但清空失效的 lj_ key，避免后续调用报含混的 401
      const settings = await loadAISettings();
      if (settings) await saveAISettings(clearLingjiProviderKeys(settings));
    } catch {
      /* 清 key 失败不阻断退出 */
    }
    setAccount(null);
    setMenuOpen(false);
    setError(null);
  }, []);

  if (!account) {
    return (
      <div>
        <button type="button" className={styles.pill} onClick={login} disabled={loading}>
          <LogIn size={13} strokeWidth={1.8} />
          {loading ? '授权中…' : '登录灵机剪影'}
        </button>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={styles.pill}
        onClick={toggleMenu}
        title={account.email}
      >
        {account.avatarUrl ? (
          <img src={account.avatarUrl} alt="" className={styles.avatar} />
        ) : (
          <User size={13} strokeWidth={1.8} />
        )}
        <span className={styles.email}>{account.displayName || account.email}</span>
        <span className={styles.balance}>{account.balance} 积分</span>
      </button>
      {menuOpen && (
        <div className={styles.menu}>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.menuRow}>
            <span>账号</span>
            <strong>{account.email}</strong>
          </div>
          <div className={styles.menuRow}>
            <span>会员</span>
            <strong>{account.tier}</strong>
          </div>
          <div className={styles.menuRow}>
            <span>积分余额</span>
            <strong>{account.balance}</strong>
          </div>
          <button type="button" className={styles.logout} onClick={logout}>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
