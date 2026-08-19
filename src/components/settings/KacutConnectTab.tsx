import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAISettings, saveAISettings } from '../../store/ai';
import { SettingsPageHeader, useToast } from '../../ui';
import { normalizeKacutSettings, type KacutSettings } from '../../types/ai';
import { KacutConnectSection } from './KacutConnectSection';
import styles from './SettingsCommon.module.css';

/**
 * 素材联动 tab：灵机素材（KaCut）MCP 服务连接配置。
 * 即改即存，不参与其他 tab 的脏检查；保存前先读盘合并，避免覆盖其他 tab 刚写入的字段。
 */
export function KacutConnectTab() {
  const { showToast } = useToast();
  const [kacut, setKacut] = useState<KacutSettings>(normalizeKacutSettings(undefined));
  const [hasLoaded, setHasLoaded] = useState(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void loadAISettings().then((settings) => {
      setKacut(normalizeKacutSettings(settings?.kacut));
      setHasLoaded(true);
    });
  }, []);

  const handleSave = useCallback(
    (next: KacutSettings) => {
      const operation = saveQueueRef.current.then(async () => {
        const current = await loadAISettings();
        if (!current) {
          throw new Error('AI 配置尚未初始化，请先在「AI 基础配置」页保存一次。');
        }
        await saveAISettings({ ...current, kacut: next });
        setKacut(next);
      });
      // Serialize read-merge-write updates so a blur save cannot overwrite a later
      // successful health test with stale enabled=false state.
      saveQueueRef.current = operation.catch(() => undefined);
      return operation.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, { title: '保存素材联动配置失败', type: 'error', duration: 4000 });
        throw err;
      });
    },
    [showToast],
  );

  return (
    <>
      <SettingsPageHeader
        title="素材联动"
        description="连接本机灵机素材（KaCut）App 的素材索引服务，让导演流水线直接检索真实素材上屏"
      />
      <div className={styles.formStack}>
        <KacutConnectSection kacut={kacut} disabled={!hasLoaded} onSave={handleSave} />
      </div>
    </>
  );
}
