import { useCallback, useRef, useState } from 'react';
import { ArrowLeft, Bot, Cpu, DatabaseBackup, Heart, MessageCircle, Music2, Share2, Sparkles, Volume2 } from 'lucide-react';
import { ConfigBackupTab } from '../components/settings/ConfigBackupTab';
import { AIConfigTab } from '../components/settings/AIConfigTab';
import { TTSConfigTab } from '../components/settings/TTSConfigTab';
import { SunoAudioConfigTab } from '../components/settings/SunoAudioConfigTab';
import { AgentSettingsTab } from '../components/settings/AgentSettingsTab';
import { PromptsConfigTab } from '../components/settings/PromptsConfigTab';
import { PublishAccountsTab } from '../components/settings/PublishAccountsTab';
import { SupportAuthorTab } from '../components/settings/SupportAuthorTab';
import { ContactAuthorTab } from '../components/settings/ContactAuthorTab';
import { Button, ConfirmDialog, Tabs, TabsContent } from '../ui';
import styles from './Settings.module.css';
import type { SettingsLeaveGuard } from '../components/settings/useSettingsTabGuard';

export type SettingsTab =
  | 'ai-config'
  | 'tts'
  | 'audio-generation'
  | 'agent'
  | 'prompts'
  | 'backup'
  | 'publish-accounts'
  | 'support-author'
  | 'contact-author';

const TABS: { id: SettingsTab; label: string; icon: typeof Bot }[] = [
  { id: 'ai-config', label: 'AI 基础配置', icon: Bot },
  { id: 'tts', label: '口播合成', icon: Volume2 },
  { id: 'audio-generation', label: 'BGM 与音效', icon: Music2 },
  { id: 'agent', label: 'AI Agent', icon: Cpu },
  { id: 'prompts', label: '提示词配置', icon: Sparkles },
  { id: 'backup', label: '配置备份', icon: DatabaseBackup },
  { id: 'publish-accounts', label: '发布账号', icon: Share2 },
  { id: 'contact-author', label: '联系作者', icon: MessageCircle },
  { id: 'support-author', label: '支持作者', icon: Heart },
];

interface SettingsProps {
  onBack: () => void;
  /** 初始定位的 tab（如从对话头部 agent 标记进入时定位 'agent'）。 */
  initialTab?: SettingsTab;
}

interface LeaveConfirmation {
  title: string;
  resolve: (confirmed: boolean) => void;
}

export function Settings({ onBack, initialTab }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'ai-config');
  const [leaveConfirmation, setLeaveConfirmation] = useState<LeaveConfirmation | null>(null);
  const tabLeaveGuardRef = useRef<SettingsLeaveGuard | null>(null);

  const confirmLeave = useCallback(
    (title: string) =>
      new Promise<boolean>((resolve) => {
        setLeaveConfirmation({ title, resolve });
      }),
    [],
  );

  const settleLeaveConfirmation = useCallback((confirmed: boolean) => {
    setLeaveConfirmation((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const handleProtectedLeave = useCallback(
    async (action: () => void) => {
      if (tabLeaveGuardRef.current) {
        const canLeave = await tabLeaveGuardRef.current();
        if (!canLeave) {
          return;
        }
      }

      action();
    },
    [],
  );

  const handleSelectTab = useCallback(
    (nextTab: string) => {
      const target = nextTab as SettingsTab;
      if (target === activeTab) {
        return;
      }
      void handleProtectedLeave(() => setActiveTab(target));
    },
    [activeTab, handleProtectedLeave],
  );

  return (
    <Tabs value={activeTab} onValueChange={handleSelectTab} className={styles.page} data-agent-zone="settings">
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <Button.Icon
            type="button"
            onClick={() => {
              void handleProtectedLeave(onBack);
            }}
            variant="ghost"
            size="sm"
            className={styles.backButton}
            aria-label="返回上一级"
          >
            <ArrowLeft size={18} />
          </Button.Icon>
          <span className={styles.sidebarTitle}>系统设置</span>
        </div>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              key={tab.id}
              type="button"
              onClick={() => handleSelectTab(tab.id)}
              variant={activeTab === tab.id ? 'accent' : 'ghost'}
              size="sm"
              className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabButtonActive : ''}`}
            >
              <Icon size={16} />
              {tab.label}
            </Button>
          );
        })}
      </div>

      <div className={styles.content}>
        <TabsContent value="ai-config" className={styles.contentPanel}>
          <AIConfigTab
            confirmLeave={confirmLeave}
            onRegisterLeaveGuard={(guard) => {
              tabLeaveGuardRef.current = guard;
            }}
          />
        </TabsContent>
        <TabsContent value="tts" className={styles.contentPanel}>
          <TTSConfigTab
            confirmLeave={confirmLeave}
            onRegisterLeaveGuard={(guard) => {
              tabLeaveGuardRef.current = guard;
            }}
          />
        </TabsContent>
        <TabsContent value="audio-generation" className={styles.contentPanel}>
          <SunoAudioConfigTab
            confirmLeave={confirmLeave}
            onRegisterLeaveGuard={(guard) => {
              tabLeaveGuardRef.current = guard;
            }}
          />
        </TabsContent>
        <TabsContent value="agent" className={styles.contentPanel}>
          <AgentSettingsTab />
        </TabsContent>
        <TabsContent value="prompts" className={styles.contentPanelWide}>
          <PromptsConfigTab />
        </TabsContent>
        <TabsContent value="backup" className={styles.contentPanel}>
          <ConfigBackupTab />
        </TabsContent>
        <TabsContent value="publish-accounts" className={styles.contentPanel}>
          <PublishAccountsTab />
        </TabsContent>
        <TabsContent value="contact-author" className={styles.contentPanel}>
          <ContactAuthorTab />
        </TabsContent>
        <TabsContent value="support-author" className={styles.contentPanel}>
          <SupportAuthorTab />
        </TabsContent>
      </div>

      <ConfirmDialog
        open={leaveConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) settleLeaveConfirmation(false);
        }}
        title={`${leaveConfirmation?.title ?? '当前配置'}尚未保存`}
        description="保存更改后再离开当前页面？"
        confirmText="保存并离开"
        cancelText="留在此页"
        onConfirm={() => settleLeaveConfirmation(true)}
        onCancel={() => settleLeaveConfirmation(false)}
      />
    </Tabs>
  );
}
