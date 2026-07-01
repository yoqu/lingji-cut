import { useCallback, useEffect, useState } from 'react';
import { LogIn, User } from 'lucide-react';
import type { LingjiAccount } from '../../lib/electron-api';
import { applyLingjiFallbackProviders } from '../../lib/llm/lingji-gateway';
import { buildDefaultAISettings, loadAISettings, saveAISettings } from '../../store/ai';
import styles from './AccountBadge.module.css';

/**
 * 欢迎页账号面板：未登录显示浏览器授权登录入口；登录后展示邮箱/积分/会员档位与退出。
 * 登录成功自动 upsert 四类兜底 Provider（服务器基址由主进程烘焙，渲染层不可见改）。
 */
export function AccountBadge() {
  const [account, setAccount] = useState<LingjiAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
      setAccount(await window.electronAPI.lingjiGetAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.lingjiLogout();
    setAccount(null);
    setMenuOpen(false);
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
        onClick={() => setMenuOpen((v) => !v)}
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
