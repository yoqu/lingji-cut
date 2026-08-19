import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, FileText, Newspaper, Video, FolderOpen, FolderInput, Heart, MessageCircle, Send } from 'lucide-react';
import type { RecentProjectEntry } from '../lib/electron-api';
import type { VideoImportSourceInput } from '../lib/video-import-types';
import { ProjectList } from '../components/ProjectList';
import {
  ImportScriptDialog,
  type ImportSourceTab,
  type ImportWechatArticleSource,
} from '../components/script/ImportScriptDialog';
import { DouyinImportDialog } from '../components/script/DouyinImportDialog';
import { SonarInboxPanel } from '../components/setup/SonarInboxPanel';
import {
  deriveProjectName,
  inboxItemToOriginalMarkdown,
  type SonarInboxItem,
} from '../lib/sonar-inbox';
import {
  type AutoModeModelBinding,
  type AutoModeOption,
} from '../components/script/AutoModeSection';
import type { AISettings } from '../types/ai';
import { normalizeTTSSettings } from '../lib/tts-settings';
import { useScriptStore } from '../store/script';
import { loadAISettings, type AutoWorkflowParams } from '../store/ai';
import { getAllRoles } from '../lib/script-templates';
import heroBg from '../assets/hero-bg.png';
import { DonateDialog } from '../components/Donate';
import { ContactDialog } from '../components/Contact';
import styles from './Setup.module.css';

interface SetupProps {
  projectName: string;
  recentProjects: RecentProjectEntry[];
  onOpenRecentProject: (projectDir: string) => Promise<void>;
  onRemoveRecentProject?: (projectDir: string) => Promise<void> | void;
  /** 文稿导入完成回调：传入父目录、项目名、原稿内容、是否一键成稿、自动模式参数、写稿模型绑定、公众号来源 */
  onImportScript: (
    parentDir: string,
    projectName: string,
    content: string,
    autoMode: boolean,
    autoParams: AutoWorkflowParams,
    modelBinding: AutoModeModelBinding | null,
    wechatArticle: ImportWechatArticleSource | null,
  ) => Promise<void>;
  onOpenSettings: () => void;
  /** 媒体导入完成回调：传入父目录、标题、导入源（抖音链接 / 本地视频 / 本地音频）、是否一键成稿、自动模式参数、写稿模型绑定 */
  onMediaImport: (
    parentDir: string,
    title: string,
    source: VideoImportSourceInput,
    autoMode: boolean,
    autoParams: AutoWorkflowParams,
    modelBinding: AutoModeModelBinding | null,
  ) => Promise<void>;
  /** 导入项目回调：打开导入项目向导（处理跨机器项目目录识别与路径修复） */
  onImportProject: () => void;
  /** 发布中心入口：打开工作目录 → 识别回填 → 一键发布 */
  onOpenPublishHub: () => void;
}

export function Setup({
  projectName,
  recentProjects,
  onOpenRecentProject,
  onRemoveRecentProject,
  onImportScript,
  onMediaImport,
  onImportProject,
  onOpenPublishHub,
}: SetupProps) {
  // ── 导入媒体弹窗（抖音 / 本地视频 / 本地音频，统一多 Tab，create 模式）──
  const [mediaImportOpen, setMediaImportOpen] = useState(false);

  // ── 导入文稿弹窗状态 ──
  const [importScriptOpen, setImportScriptOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [importScriptCreating, setImportScriptCreating] = useState(false);
  const [importScriptError, setImportScriptError] = useState<string | null>(null);
  // 导入文稿弹窗打开时激活的来源 Tab（「公众号导入」入口直达 wechat Tab）
  const [importScriptSourceTab, setImportScriptSourceTab] = useState<ImportSourceTab>('text');
  // ── 待创作箱触发的预填项（非空表示当前弹窗服务于某条 inbox 素材）──
  const [inboxDraftItem, setInboxDraftItem] = useState<SonarInboxItem | null>(null);

  // ── 一键成稿 (AutoModeSection) 下拉选项与默认值 ──
  // selectedTemplate / selectedRole 来自 script store；voice 默认值需异步从磁盘读取 AISettings
  const selectedTemplate = useScriptStore((s) => s.selectedTemplate);
  const selectedRole = useScriptStore((s) => s.selectedRole);
  const [voiceIdDefault, setVoiceIdDefault] = useState('male-qn-qingse');
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  useEffect(() => {
    void (async () => {
      const settings = await loadAISettings();
      if (!settings) return;
      const normalized = normalizeTTSSettings(settings);
      setAiSettings(normalized);
      const defaultVoice = normalized.ttsVoices.find(
        (voice) => voice.id === normalized.defaultTtsVoiceId,
      );
      if (defaultVoice) {
        setVoiceIdDefault(
          defaultVoice.providerType === 'minimax' && defaultVoice.voiceId
            ? defaultVoice.voiceId
            : defaultVoice.id,
        );
      }
    })();
  }, []);

  const autoModeOptions = useMemo(() => {
    const models: AutoModeOption[] = [];
    for (const provider of aiSettings?.llmProviders ?? []) {
      for (const model of provider.models ?? []) {
        models.push({
          value: `${provider.id}::${model}`,
          label: `${provider.name} / ${model}`,
        });
      }
    }
    const defaultModelBinding: AutoModeModelBinding | null =
      aiSettings?.defaultProviderId && aiSettings?.defaultModel
        ? { providerId: aiSettings.defaultProviderId, model: aiSettings.defaultModel }
        : null;
    return {
      // getAllRoles() 已合并：NONE_ROLE + 内置模板（派生角色）+ 用户自定义角色，
      // 与写稿工作台 QuickActionBar 的角色下拉保持一致口径。
      roles: getAllRoles().map((r) => ({ value: r.id, label: r.name })),
      voices: (aiSettings?.ttsVoices ?? []).map((voice) => ({
        value: voice.providerType === 'minimax' && voice.voiceId ? voice.voiceId : voice.id,
        label: `${voice.name}${voice.source === 'cloned' ? '（克隆）' : ''}`,
      })),
      models,
      defaults: {
        // templateId 在 UI 上不再暴露；沿用当前工作台选中的模板作为写稿结构，
        // role 作为风格/身份前缀。与 ScriptWorkbench 运行时口径一致。
        templateId: selectedTemplate || 'news-broadcast',
        roleId: selectedRole || 'none',
        voiceId: voiceIdDefault,
        productionMode: 'auto',
      } satisfies AutoWorkflowParams,
      defaultModelBinding,
    };
  }, [aiSettings, selectedTemplate, selectedRole, voiceIdDefault]);

  // 待创作箱「生成初稿」：打开预填的「导入文稿」弹窗，让用户选目录/写稿模型/角色/音色，
  // 默认一键模式开 + 二创转述模板；确认后走与普通导入完全相同的 onImportScript。
  const handleRequestDraftFromInbox = useCallback((item: SonarInboxItem) => {
    setInboxDraftItem(item);
    setImportScriptError(null);
    setImportScriptCreating(false);
    setImportScriptOpen(true);
  }, []);

  // ── 导入文稿弹窗操作 ──
  const handleOpenImportScript = useCallback(() => {
    setInboxDraftItem(null);
    setImportScriptError(null);
    setImportScriptCreating(false);
    setImportScriptSourceTab('text');
    setImportScriptOpen(true);
  }, []);

  // 公众号导入：同一弹窗，直达公众号文章 Tab
  const handleOpenWechatImport = useCallback(() => {
    setInboxDraftItem(null);
    setImportScriptError(null);
    setImportScriptCreating(false);
    setImportScriptSourceTab('wechat');
    setImportScriptOpen(true);
  }, []);

  const handleOpenMediaImport = useCallback(() => {
    setMediaImportOpen(true);
  }, []);

  const handleConfirmImportScript = useCallback(
    async (
      parentDir: string,
      projectNameInput: string,
      content: string,
      autoMode: boolean,
      autoParams: AutoWorkflowParams,
      modelBinding: AutoModeModelBinding | null,
      wechatArticle: ImportWechatArticleSource | null,
    ) => {
      setImportScriptCreating(true);
      setImportScriptError(null);
      try {
        await onImportScript(
          parentDir,
          projectNameInput,
          content,
          autoMode,
          autoParams,
          modelBinding,
          wechatArticle,
        );
        // 来自待创作箱：项目已创建并起飞流水线 → 标记该收件项为「已生成」并记录项目路径，避免重复创作。
        if (inboxDraftItem) {
          void window.electronAPI
            .sonarInboxMarkStatus?.(inboxDraftItem.id, 'drafted', {
              projectPath: `${parentDir}/${projectNameInput}`,
            })
            .catch(() => {});
          setInboxDraftItem(null);
        }
        setImportScriptOpen(false);
      } catch (err) {
        setImportScriptError(err instanceof Error ? err.message : '创建项目失败');
      } finally {
        setImportScriptCreating(false);
      }
    },
    [onImportScript, inboxDraftItem],
  );

  // 弹窗关闭（含取消）：清空 inbox 预填，收件项保持 pending。
  const handleImportScriptOpenChange = useCallback((next: boolean) => {
    setImportScriptOpen(next);
    if (!next) setInboxDraftItem(null);
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.welcomeContent}>
        {/* ── Hero Banner ── */}
        <div className={styles.heroBanner}>
          <img src={heroBg} alt="" className={styles.heroBannerImage} />
          <div className={styles.heroBannerOverlay} />
          {projectName && (
            <div className={styles.projectBadge}>
              <FolderOpen size={13} strokeWidth={1.8} />
              {projectName}
            </div>
          )}
          <div className={styles.heroTopRight}>
            <button
              type="button"
              className={styles.donateBadge}
              onClick={() => setDonateOpen(true)}
              title="支持作者"
            >
              <Heart size={13} strokeWidth={1.8} />
              支持作者
            </button>
          </div>
          <button
            type="button"
            className={styles.createButton}
            onClick={handleOpenImportScript}
          >
            <Plus size={18} strokeWidth={2.2} />
            开始创作
          </button>
        </div>

        {/* ── 快捷功能行 ── */}
        <div className={styles.quickBar}>
          <button
            type="button"
            className={styles.quickItem}
            onClick={handleOpenImportScript}
          >
            <div className={styles.quickItemIcon}>
              <FileText size={22} strokeWidth={1.5} />
            </div>
            <span className={styles.quickItemLabel}>导入文稿</span>
          </button>
          {/* 公众号导入入口：抓取 mp.weixin.qq.com 文章转 Markdown（含图片下载）创建项目 */}
          <button
            type="button"
            className={styles.quickItem}
            onClick={handleOpenWechatImport}
          >
            <div className={styles.quickItemIcon}>
              <Newspaper size={22} strokeWidth={1.5} />
            </div>
            <span className={styles.quickItemLabel}>公众号导入</span>
          </button>
          {/* 导入媒体入口：抖音链接 / 本地视频 / 本地音频统一多 Tab 弹窗，自动转录创建项目 */}
          <button
            type="button"
            className={styles.quickItem}
            onClick={handleOpenMediaImport}
          >
            <div className={styles.quickItemIcon}>
              <Video size={22} strokeWidth={1.5} />
            </div>
            <span className={styles.quickItemLabel}>导入媒体</span>
          </button>
          {/* 导入项目入口：识别跨机器复制过来的项目目录并修复素材路径 */}
          <button
            type="button"
            className={styles.quickItem}
            onClick={onImportProject}
          >
            <div className={styles.quickItemIcon}>
              <FolderInput size={22} strokeWidth={1.5} />
            </div>
            <span className={styles.quickItemLabel}>导入项目</span>
          </button>
          {/* 发布中心：工作目录识别回填后一键发布全平台 */}
          <button
            type="button"
            className={styles.quickItem}
            onClick={onOpenPublishHub}
          >
            <div className={styles.quickItemIcon}>
              <Send size={22} strokeWidth={1.5} />
            </div>
            <span className={styles.quickItemLabel}>发布视频</span>
          </button>
        </div>

        {/* ── 工作区：左侧待创作箱 / 右侧本地草稿，各自独立滚动，互不挤压 ── */}
        <div className={styles.workspaceRow}>
          {/* 待创作箱（声呐监听推入的二创素材） */}
          <SonarInboxPanel onRequestDraft={handleRequestDraftFromInbox} />

          {/* 本地草稿 */}
          <div className={styles.draftsSection}>
            <ProjectList
              projects={recentProjects}
              onOpenProject={onOpenRecentProject}
              onRemoveProject={onRemoveRecentProject}
            />
          </div>
        </div>
          {/* 底部常驻：联系作者与赞赏支持 */}
          <div className={styles.supportBar}>
            <span className={styles.supportBarText}>喜欢灵机剪影？欢迎联系作者交流，或赞赏支持作者持续维护</span>
            <div className={styles.supportBarActions}>
              <button
                type="button"
                className={styles.supportBarButton}
                onClick={() => setContactOpen(true)}
              >
                <MessageCircle size={14} strokeWidth={1.8} />
                联系作者
              </button>
              <button
                type="button"
                className={styles.supportBarButton}
                onClick={() => setDonateOpen(true)}
              >
                <Heart size={14} strokeWidth={1.8} />
                赞赏支持
              </button>
            </div>
          </div>
      </div>

      {/* ── 导入文稿弹窗：粘贴/拖拽/选择文件 → 选目录 → 起飞 AI 写稿 ── */}
      <ImportScriptDialog
        open={importScriptOpen}
        busy={importScriptCreating}
        errorMessage={importScriptError}
        onOpenChange={handleImportScriptOpenChange}
        onConfirm={handleConfirmImportScript}
        autoModeOptions={autoModeOptions}
        initialContent={inboxDraftItem ? inboxItemToOriginalMarkdown(inboxDraftItem) : undefined}
        initialProjectName={inboxDraftItem ? deriveProjectName(inboxDraftItem) : undefined}
        initialAutoMode={inboxDraftItem ? true : undefined}
        templateIdOverride={inboxDraftItem ? 'rewrite-remix' : undefined}
        initialSourceTab={importScriptSourceTab}
      />

      {/* ── 导入媒体弹窗：抖音 / 本地视频 / 本地音频统一入口，create 模式创建项目 ── */}
      <DouyinImportDialog
        open={mediaImportOpen}
        onOpenChange={setMediaImportOpen}
        mode="create"
        autoModeOptions={autoModeOptions}
        onCreate={onMediaImport}
      />

      <DonateDialog open={donateOpen} onOpenChange={setDonateOpen} />
      <ContactDialog open={contactOpen} onOpenChange={setContactOpen} />
    </div>
  );
}
