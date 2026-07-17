import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioWaveform, TestTube2 } from 'lucide-react';
import { Alert, Button, ConfirmDialog, Field, Input, NumberField, SaveButton, Select, SettingsPageHeader, Switch, useToast } from '../../ui';
import { normalizeSunoAudioSettings } from '../../lib/audio-gen/settings';
import { buildDefaultAISettings, loadAISettings, saveAISettings } from '../../store/ai';
import type { AudioGenerationSmokeTestResult } from '../../lib/audio-gen/types';
import type { SunoAudioGenerationSettings } from '../../types/ai';
import { useSettingsTabGuard } from './useSettingsTabGuard';
import commonStyles from './SettingsCommon.module.css';
import styles from './SunoAudioConfigTab.module.css';

interface SunoAudioConfigTabProps {
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  confirmLeave?: (title: string) => Promise<boolean>;
}

export function validateSunoAudioConfig(settings: SunoAudioGenerationSettings): string | null {
  if (!settings.enabled) return null;
  if (!settings.apiKey.trim()) return '请输入 SunoAPI.org API Key';
  if (!validHttpUrl(settings.baseUrl)) return 'Base URL 必须是有效的 HTTP 或 HTTPS 地址';
  if (settings.callbackUrl && !validHttpUrl(settings.callbackUrl)) {
    return 'Callback URL 必须是有效的公网 HTTP 或 HTTPS 地址';
  }
  return null;
}

function validHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function SunoAudioConfigTab({
  onRegisterLeaveGuard,
  confirmLeave,
}: SunoAudioConfigTabProps) {
  const { showToast } = useToast();
  const [settings, setSettings] = useState(() => normalizeSunoAudioSettings());
  const [loaded, setLoaded] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [smokeTesting, setSmokeTesting] = useState(false);
  const [confirmSmoke, setConfirmSmoke] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [smokeResult, setSmokeResult] = useState<AudioGenerationSmokeTestResult | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const snapshot = useMemo(() => JSON.stringify(normalizeSunoAudioSettings(settings)), [settings]);
  const hasUnsavedChanges = loaded && snapshot !== savedSnapshot;
  const validationError = validateSunoAudioConfig(settings);

  useEffect(() => {
    void loadAISettings().then((current) => {
      const next = normalizeSunoAudioSettings(current?.audioGeneration);
      setSettings(next);
      setSavedSnapshot(JSON.stringify(next));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (hasUnsavedChanges) {
      setSaved(false);
      setCredits(null);
      setSmokeResult(null);
      setConnectionError(null);
    }
  }, [hasUnsavedChanges]);

  const handleSave = useCallback(async () => {
    const normalized = normalizeSunoAudioSettings(settings);
    const error = validateSunoAudioConfig(normalized);
    if (error) {
      setConnectionError(error);
      return false;
    }
    try {
      const current = await loadAISettings();
      await saveAISettings({ ...(current ?? buildDefaultAISettings()), audioGeneration: normalized });
      const nextSnapshot = JSON.stringify(normalized);
      setSettings(normalized);
      setSavedSnapshot(nextSnapshot);
      setSaved(true);
      return true;
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '请稍后重试。', {
        title: '保存 SunoAPI 配置失败', type: 'error', duration: 5000,
      });
      return false;
    }
  }, [settings, showToast]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setConnectionError(null);
    try {
      if (!(await handleSave())) return;
      const balance = await window.electronAPI.getSunoCredits();
      setCredits(balance);
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : 'SunoAPI 连接测试失败');
    } finally {
      setTesting(false);
    }
  }, [handleSave]);

  const handleSmokeTest = useCallback(async () => {
    setSmokeTesting(true);
    setConnectionError(null);
    setSmokeResult(null);
    try {
      if (!(await handleSave())) return;
      const result = await window.electronAPI.testSunoAudioGeneration();
      setSmokeResult(result);
      setCredits(result.creditsRemaining);
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : 'SunoAPI 完整链路测试失败');
    } finally {
      setSmokeTesting(false);
    }
  }, [handleSave]);

  useSettingsTabGuard({
    title: 'BGM 与音效', hasUnsavedChanges, onSave: handleSave,
    onRegisterLeaveGuard, confirmLeave,
  });

  return (
    <>
      <SettingsPageHeader title="BGM 与音效" description="配置 SunoAPI.org，用于生成背景音乐、环境声、stinger 和特色音效" />
      <div className={commonStyles.formStack}>
        <Field label="SunoAPI.org" hint="只有本地素材库没有合格素材时才调用此服务。">
          <Switch checked={settings.enabled} label={settings.enabled ? '已启用' : '未启用'}
            onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))} />
        </Field>
        <Field label="API Key" hint="密钥只保存在本机全局配置中，不会写入项目文件。">
          <Input variant="password" value={settings.apiKey} autoComplete="off"
            placeholder="输入 SunoAPI.org API Key" disabled={!settings.enabled}
            onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.target.value }))} />
        </Field>
        <Field label="Base URL">
          <Input value={settings.baseUrl} placeholder="https://api.sunoapi.org" disabled={!settings.enabled}
            onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))} />
        </Field>
        <Field label="Callback URL" hint="SunoAPI 强制要求。留空时自动使用灵机回调入口，桌面端仍通过轮询读取生成结果。">
          <Input value={settings.callbackUrl} placeholder="https://example.com/callback/suno" disabled={!settings.enabled}
            onChange={(event) => setSettings((current) => ({ ...current, callbackUrl: event.target.value }))} />
        </Field>
        <Field label="默认音乐模型">
          <Select value={settings.musicModel} disabled={!settings.enabled}
            options={[{ value: 'V5', label: 'V5（稳定默认）' }, { value: 'V5_5', label: 'V5.5（高级）' }]}
            onChange={(event) => setSettings((current) => ({ ...current, musicModel: event.target.value === 'V5_5' ? 'V5_5' : 'V5' }))} />
        </Field>
        <div className={styles.timingGrid}>
          <NumberField label="轮询间隔" value={(settings.pollIntervalMs ?? 10_000) / 1_000} min={2} max={60} unit="秒"
            disabled={!settings.enabled} onChange={(value) => setSettings((current) => ({ ...current, pollIntervalMs: value * 1_000 }))} />
          <NumberField label="任务超时" value={(settings.timeoutMs ?? 600_000) / 60_000} min={1} max={30} unit="分钟"
            disabled={!settings.enabled} onChange={(value) => setSettings((current) => ({ ...current, timeoutMs: value * 60_000 }))} />
        </div>
        {connectionError || validationError ? <Alert variant="destructive">{connectionError ?? validationError}</Alert> : null}
        {credits !== null ? <div className={styles.connectionStatus}>连接成功，当前 credits：<strong>{credits}</strong></div> : null}
        {smokeResult ? (
          <div className={styles.connectionStatus}>
            完整链路通过：{smokeResult.candidateCount} 个候选，测试音效 {(smokeResult.durationMs / 1_000).toFixed(1)} 秒
          </div>
        ) : null}
      </div>
      <div className={styles.actions}>
        <SaveButton onClick={() => void handleSave()} saved={saved}
          disabled={!loaded || !hasUnsavedChanges || Boolean(validationError)} defaultLabel="保存配置" />
        <Button variant="secondary" loading={testing} loadingText="测试中" leftIcon={<TestTube2 size={14} />} disabled={!loaded || !settings.enabled || Boolean(validationError)}
          onClick={() => void handleTest()}>测试连接并查询积分</Button>
        <Button variant="secondary" loading={smokeTesting} loadingText="生成测试音效中" leftIcon={<AudioWaveform size={14} />}
          disabled={!loaded || !settings.enabled || Boolean(validationError)} onClick={() => setConfirmSmoke(true)}>
          测试完整生成链路
        </Button>
      </div>
      <ConfirmDialog open={confirmSmoke} onOpenChange={setConfirmSmoke}
        title="生成一段测试音效？"
        description="将调用 SunoAPI 生成约 2 秒的测试音效，消耗少量 credits。应用会完成轮询、下载和音频校验，测试文件随后自动删除。"
        confirmText="开始测试" onConfirm={handleSmokeTest} />
    </>
  );
}
