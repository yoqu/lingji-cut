import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Variable,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CodeEditor,
  ConfirmDialog,
  Field,
  Input,
  NumberField,
  SettingsPageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '../../ui';
import {
  PROMPT_CATEGORY_META,
  PROMPT_KINDS,
  PROMPT_KIND_META,
  userPromptBindingKey,
  type PromptCategory,
  type PromptCategoryMeta,
  type PromptKind,
  type PromptKindMeta,
  type PromptScope,
  type UserPromptEntry,
} from '../../lib/prompts';
import { SCRIPT_TEMPLATE_SEEDS } from '../../lib/prompts/script-template-defaults';
import { getProjectDir } from '../../store/timeline';
import { loadAISettings, saveAISettings, useAIStore } from '../../store/ai';
import {
  PromptBindingError,
  resolvePromptBinding,
  resolveUserPromptBinding,
  type ResolvedBinding,
} from '../../lib/llm/binding-resolver';
import type {
  AISettings,
  ImageProvider,
  LLMProvider,
  PromptBinding,
  PromptBindingMap,
  VideoProvider,
} from '../../types/ai';
import { PromptBindingBar } from './PromptBindingBar';
import { StyleLibraryPanel } from '../StyleLibraryPanel';
import { resolveStylePresetId } from '../../lib/card-style';
import styles from './PromptsConfigTab.module.css';

type EditableScope = 'global' | 'project';

/**
 * 当前激活条目：要么是 PromptKind（内置提示词），要么是 category + id（用户条目，如口播模板）
 */
type ActiveSelection =
  | { type: 'kind'; kind: PromptKind }
  | { type: 'user-entry'; category: PromptCategory; entryId: string }
  | { type: 'style' };

interface OverviewItem {
  kind: PromptKind;
  effectiveScope: PromptScope;
  hasGlobal: boolean;
  hasProject: boolean;
  meta: PromptKindMeta;
}

const GROUP_LABEL: Record<PromptKindMeta['group'], string> = {
  project: '项目设计语言',
  'ai-analysis': '内容分析与卡片',
  script: '文稿流程',
};

const SCOPE_LABEL: Record<PromptScope, string> = {
  builtin: '内置',
  global: '全局',
  project: '项目',
};

const SCOPE_BADGE_VARIANT: Record<PromptScope, React.ComponentProps<typeof Badge>['variant']> = {
  builtin: 'outline',
  global: 'info',
  project: 'success',
};

type BindingBadgeVariant = React.ComponentProps<typeof Badge>['variant'];

interface BindingBadgeInfo {
  label: string;
  variant: BindingBadgeVariant;
}

/**
 * 计算某个 kind 的绑定 Badge 状态：
 * - motion.system 不可配：—
 * - 当前作用域无显式绑定：继承
 * - 有绑定但解析失败：❗失效
 * - 正常：model 或 model · imageModel
 */
function computeBindingBadge(
  kind: PromptKind,
  scope: 'global' | 'project',
  settings: AISettings | null,
  projectBindings: PromptBindingMap,
): BindingBadgeInfo {
  const explicit =
    scope === 'project'
      ? projectBindings[kind]
      : settings?.promptBindings?.[kind];
  if (!explicit) {
    return { label: '继承', variant: 'secondary' };
  }

  if (!settings) {
    return { label: '❗失效', variant: 'destructive' };
  }

  try {
    const resolved = resolvePromptBinding(kind, settings, projectBindings);
    if ((kind === 'cover.regeneration' || kind === 'card.image') && resolved.imageModel) {
      return {
        label: `${resolved.model} · ${resolved.imageModel}`,
        variant: 'info',
      };
    }
    if (kind === 'card.video' && resolved.videoModel) {
      return {
        label: `${resolved.model} · ${resolved.videoModel}`,
        variant: 'info',
      };
    }
    return { label: resolved.model, variant: 'info' };
  } catch {
    return { label: '❗失效', variant: 'destructive' };
  }
}

/** 为新建条目生成 id：custom-<timestamp>-<rand4> */
function generateCustomEntryId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `custom-${Date.now().toString(36)}-${rand}`;
}

/** 判断一个用户条目是否属于内置 seed（用于"恢复默认"按钮） */
function isBuiltinSeedId(category: PromptCategory, id: string): boolean {
  if (category === 'script-template') {
    return SCRIPT_TEMPLATE_SEEDS.some((seed) => seed.id === id);
  }
  return false;
}

export function PromptsConfigTab() {
  const { showToast } = useToast();
  const [projectDir] = useState<string>(() => getProjectDir());
  const hasProject = Boolean(projectDir);

  const [overview, setOverview] = useState<OverviewItem[]>([]);
  const [active, setActive] = useState<ActiveSelection>({
    type: 'kind',
    kind: PROMPT_KINDS[0],
  });
  const [scope, setScope] = useState<EditableScope>('global');
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [isOverride, setIsOverride] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<EditableScope | null>(null);

  // ─── 提示词 × AI 绑定相关状态 ────────────────────
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const projectBindings = useAIStore((s) => s.projectBindings);
  const loadProjectBindings = useAIStore((s) => s.loadProjectBindings);
  const setProjectBinding = useAIStore((s) => s.setProjectBinding);
  const setGlobalBinding = useAIStore((s) => s.setGlobalBinding);

  // ─── 项目统一风格（风格模板选择器）────────────────
  const projectStylePresetId = useAIStore((s) => s.projectStylePresetId);
  const setProjectStylePresetId = useAIStore((s) => s.setProjectStylePresetId);

  /** 写入全局默认风格：持久化到 aiSettings 并同步本地状态 */
  const persistGlobalStyle = useCallback(
    async (id: string) => {
      try {
        const current = await loadAISettings();
        if (!current) return;
        const next: AISettings = { ...current, defaultStylePresetId: id };
        await saveAISettings(next);
        setAiSettings(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, { title: '保存全局风格失败', type: 'error', duration: 4000 });
      }
    },
    [showToast],
  );

  // ─── 用户自定义条目（口播模板等）────────────────
  const userPromptEntries = useAIStore((s) => s.userPromptEntries);
  const loadUserPrompts = useAIStore((s) => s.loadUserPrompts);
  const saveUserPrompt = useAIStore((s) => s.saveUserPrompt);
  const deleteUserPrompt = useAIStore((s) => s.deleteUserPrompt);

  const scriptTemplateEntries: UserPromptEntry[] =
    userPromptEntries['script-template'] ?? [];
  const scriptTemplateMeta: PromptCategoryMeta = PROMPT_CATEGORY_META['script-template'];

  // 口播模板编辑器的本地草稿（独立于 YAML content/originalContent）
  const [templateDraft, setTemplateDraft] = useState<UserPromptEntry | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<string | null>(null);

  const projectDirArg = hasProject ? projectDir : undefined;

  const refreshOverview = useCallback(async () => {
    const items = await window.electronAPI.listPrompts({ projectDir: projectDirArg });
    setOverview(items);
  }, [projectDirArg]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    if (!hasProject && scope === 'project') setScope('global');
  }, [hasProject, scope]);

  /** 挂载时确保口播模板已加载（即使 App.tsx 已 load 过，再调一次幂等无害） */
  useEffect(() => {
    void loadUserPrompts('script-template');
  }, [loadUserPrompts]);

  /** 加载 AI settings（提供 llmProviders / imageProviders / 全局绑定） */
  const refreshAISettings = useCallback(async () => {
    try {
      const loaded = await loadAISettings();
      setAiSettings(loaded);
    } catch (err) {
      console.error('加载 AI Settings 失败:', err);
    }
  }, []);

  useEffect(() => {
    void refreshAISettings();
  }, [refreshAISettings]);

  /** projectDir 变化时，同步加载项目绑定 */
  useEffect(() => {
    void loadProjectBindings(projectDir || null);
  }, [projectDir, loadProjectBindings]);

  const loadKind = useCallback(
    async (kind: PromptKind, targetScope: EditableScope) => {
      setLoading(true);
      setError(null);
      try {
        const res = await window.electronAPI.readPrompt({
          kind,
          scope: targetScope,
          projectDir: projectDirArg,
        });
        if (res.content && res.content.trim()) {
          setContent(res.content);
          setOriginalContent(res.content);
          setIsOverride(true);
        } else {
          const def = await window.electronAPI.getDefaultPrompt({ kind });
          setContent(def.content);
          setOriginalContent(def.content);
          setIsOverride(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [projectDirArg],
  );

  // 切换到 kind 编辑器时加载用户可编辑的纯文本提示词正文
  useEffect(() => {
    if (active.type === 'kind') {
      void loadKind(active.kind, scope);
    }
  }, [active, scope, loadKind]);

  // 切换到用户条目时，从 store 同步草稿
  useEffect(() => {
    if (active.type !== 'user-entry') {
      setTemplateDraft(null);
      return;
    }
    const list = userPromptEntries[active.category] ?? [];
    const entry = list.find((item) => item.id === active.entryId);
    if (entry) {
      setTemplateDraft({ ...entry });
    }
    // 条目不在列表中（新建未保存）时保持既有草稿；由 handleCreateNewTemplate 设置
  }, [active, userPromptEntries]);

  const dirty = content !== originalContent;

  const groupedKinds = useMemo(() => {
    const groups: Record<PromptKindMeta['group'], OverviewItem[]> = {
      project: [],
      'ai-analysis': [],
      script: [],
    };
    for (const item of overview) groups[item.meta.group].push(item);
    return groups;
  }, [overview]);

  const activeMeta: PromptKindMeta | null =
    active.type === 'kind' ? PROMPT_KIND_META[active.kind] : null;

  // ─── 绑定相关派生数据（仅 kind 编辑模式使用） ────────
  const llmProviders: LLMProvider[] = aiSettings?.llmProviders ?? [];
  const imageProviders: ImageProvider[] = aiSettings?.imageProviders ?? [];
  const videoProviders: VideoProvider[] = aiSettings?.videoProviders ?? [];

  /** 当前作用域下该 kind 的显式绑定（undefined 表示继承） */
  const currentScopeBinding: PromptBinding | undefined = useMemo(() => {
    if (active.type !== 'kind') return undefined;
    if (scope === 'project') return projectBindings[active.kind];
    return aiSettings?.promptBindings?.[active.kind];
  }, [active, scope, projectBindings, aiSettings]);

  /** 解析后的有效绑定与错误（供显示继承值与失效提示） */
  const { resolved, bindingError } = useMemo<{
    resolved: ResolvedBinding | null;
    bindingError: PromptBindingError | null;
  }>(() => {
    if (
      active.type !== 'kind' ||
      !aiSettings ||
      PROMPT_KIND_META[active.kind].supportsBinding === false
    ) {
      return { resolved: null, bindingError: null };
    }
    try {
      const r = resolvePromptBinding(active.kind, aiSettings, projectBindings);
      return { resolved: r, bindingError: null };
    } catch (err) {
      if (err instanceof PromptBindingError) {
        return { resolved: null, bindingError: err };
      }
      return { resolved: null, bindingError: null };
    }
  }, [active, aiSettings, projectBindings]);

  // ─── 用户模板的项目级绑定派生（仅 script-template） ───
  const templateBindingKey = useMemo(() => {
    if (active.type !== 'user-entry') return null;
    return userPromptBindingKey(active.category, active.entryId);
  }, [active]);

  const templateCurrentBinding: PromptBinding | undefined = useMemo(() => {
    if (!templateBindingKey) return undefined;
    return projectBindings?.[templateBindingKey];
  }, [templateBindingKey, projectBindings]);

  const { templateResolved, templateBindingError } = useMemo<{
    templateResolved: { provider: LLMProvider; model: string } | null;
    templateBindingError: PromptBindingError | null;
  }>(() => {
    if (active.type !== 'user-entry' || !aiSettings) {
      return { templateResolved: null, templateBindingError: null };
    }
    try {
      const r = resolveUserPromptBinding(
        active.category,
        active.entryId,
        aiSettings,
        projectBindings,
      );
      return { templateResolved: r, templateBindingError: null };
    } catch (err) {
      if (err instanceof PromptBindingError) {
        return { templateResolved: null, templateBindingError: err };
      }
      return { templateResolved: null, templateBindingError: null };
    }
  }, [active, aiSettings, projectBindings]);

  const handleTemplateBindingChange = useCallback(
    async (next: PromptBinding | null) => {
      if (!templateBindingKey) return;
      try {
        await setProjectBinding(templateBindingKey, next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, { title: '更新模板绑定失败', type: 'error', duration: 4000 });
      }
    },
    [templateBindingKey, setProjectBinding, showToast],
  );

  /** 仅当当前作用域存在显式绑定、但解析失败时才显示顶部警告 */
  const showBindingWarning = Boolean(currentScopeBinding && bindingError);

  const handleBindingChange = useCallback(
    async (next: PromptBinding | null) => {
      if (active.type !== 'kind') return;
      try {
        if (scope === 'project') {
          await setProjectBinding(active.kind, next);
        } else {
          await setGlobalBinding(active.kind, next);
          await refreshAISettings();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, { title: '更新绑定失败', type: 'error', duration: 4000 });
      }
    },
    [
      active,
      scope,
      setProjectBinding,
      setGlobalBinding,
      refreshAISettings,
      showToast,
    ],
  );

  /** cover.regeneration / card.image 图像段变更：合并到同一 binding 中 */
  const handleImageBindingChange = useCallback(
    async (next: { imageProviderId: string | null; imageModel: string | null }) => {
      const current: PromptBinding | undefined = currentScopeBinding;
      const merged: PromptBinding = {
        providerId: current?.providerId ?? null,
        model: current?.model ?? null,
        imageProviderId: next.imageProviderId,
        imageModel: next.imageModel,
        videoProviderId: current?.videoProviderId ?? null,
        videoModel: current?.videoModel ?? null,
      };
      const allCleared =
        !merged.providerId &&
        !merged.model &&
        !merged.imageProviderId &&
        !merged.imageModel &&
        !merged.videoProviderId &&
        !merged.videoModel;
      await handleBindingChange(allCleared ? null : merged);
    },
    [currentScopeBinding, handleBindingChange],
  );

  /** cards.segment 并发数：全局调度配置，与提示词 scope 无关 */
  const cardConcurrencyValue =
    typeof aiSettings?.cardGenerationConcurrency === 'number' &&
    Number.isFinite(aiSettings.cardGenerationConcurrency)
      ? Math.max(1, Math.floor(aiSettings.cardGenerationConcurrency))
      : 4;
  const handleCardConcurrencyChange = useCallback(
    async (next: number) => {
      if (!aiSettings) return;
      const normalized = Math.max(1, Math.floor(Number.isFinite(next) ? next : 2));
      try {
        await saveAISettings({ ...aiSettings, cardGenerationConcurrency: normalized });
        await refreshAISettings();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(message, { title: '保存并发数失败', type: 'error', duration: 4000 });
      }
    },
    [aiSettings, refreshAISettings, showToast],
  );

  /** card.video 视频段变更：合并到同一 binding 中 */
  const handleVideoBindingChange = useCallback(
    async (next: { videoProviderId: string | null; videoModel: string | null }) => {
      const current: PromptBinding | undefined = currentScopeBinding;
      const merged: PromptBinding = {
        providerId: current?.providerId ?? null,
        model: current?.model ?? null,
        imageProviderId: current?.imageProviderId ?? null,
        imageModel: current?.imageModel ?? null,
        videoProviderId: next.videoProviderId,
        videoModel: next.videoModel,
      };
      const allCleared =
        !merged.providerId &&
        !merged.model &&
        !merged.imageProviderId &&
        !merged.imageModel &&
        !merged.videoProviderId &&
        !merged.videoModel;
      await handleBindingChange(allCleared ? null : merged);
    },
    [currentScopeBinding, handleBindingChange],
  );

  const handleSave = useCallback(async () => {
    if (active.type !== 'kind') return;
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.writePrompt({
        kind: active.kind,
        scope,
        content,
        projectDir: projectDirArg,
      });
      setOriginalContent(content);
      setIsOverride(true);
      await refreshOverview();
      const label = PROMPT_KIND_META[active.kind].label;
      showToast(`已保存 ${label}（${SCOPE_LABEL[scope]}）`, {
        type: 'success',
        duration: 2500,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(message, { title: '保存失败', type: 'error', duration: 4000 });
    } finally {
      setSaving(false);
    }
  }, [
    active,
    content,
    projectDirArg,
    refreshOverview,
    saving,
    scope,
    showToast,
  ]);

  const handleResetToDefault = useCallback(async () => {
    if (active.type !== 'kind') return;
    setError(null);
    try {
      const def = await window.electronAPI.getDefaultPrompt({ kind: active.kind });
      setContent(def.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [active]);

  const handleConfirmDeleteOverride = useCallback(async () => {
    if (active.type !== 'kind') return;
    if (!confirmReset) return;
    try {
      await window.electronAPI.deletePrompt({
        kind: active.kind,
        scope: confirmReset,
        projectDir: projectDirArg,
      });
      await refreshOverview();
      await loadKind(active.kind, confirmReset);
      const label = PROMPT_KIND_META[active.kind].label;
      showToast(`已删除 ${label} 的${SCOPE_LABEL[confirmReset]}覆盖`, {
        type: 'success',
        duration: 2500,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(message, { title: '删除失败', type: 'error', duration: 4000 });
    } finally {
      setConfirmReset(null);
    }
  }, [
    active,
    confirmReset,
    loadKind,
    projectDirArg,
    refreshOverview,
    showToast,
  ]);

  // ─── 口播模板编辑器逻辑 ─────────────────────────

  const handleCreateNewTemplate = useCallback(() => {
    const newId = generateCustomEntryId();
    const draft: UserPromptEntry = {
      id: newId,
      category: 'script-template',
      name: '',
      description: '',
      version: 1,
      system: '',
      user: '{{rawText}}',
      isBuiltin: false,
    };
    setTemplateDraft(draft);
    setActive({ type: 'user-entry', category: 'script-template', entryId: newId });
  }, []);

  const handleSelectTemplate = useCallback(
    (entryId: string) => {
      setActive({ type: 'user-entry', category: 'script-template', entryId });
    },
    [],
  );

  const handleSaveTemplate = useCallback(async () => {
    if (!templateDraft) return;
    if (templateSaving) return;
    const name = templateDraft.name.trim();
    const system = templateDraft.system.trim();
    if (!name) {
      showToast('请先填写模板名称', { type: 'error', duration: 3000 });
      return;
    }
    if (!system) {
      showToast('请先填写系统提示词', { type: 'error', duration: 3000 });
      return;
    }
    setTemplateSaving(true);
    try {
      const saved = await saveUserPrompt({
        category: 'script-template',
        id: templateDraft.id,
        name,
        description: templateDraft.description.trim(),
        version: templateDraft.version ?? 1,
        system,
        user: templateDraft.user || '{{rawText}}',
        ttsStyle: templateDraft.ttsStyle,
        ttsAnnotateHint: templateDraft.ttsAnnotateHint,
      });
      setTemplateDraft({ ...saved });
      showToast(`已保存「${saved.name}」`, { type: 'success', duration: 2500 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, { title: '保存失败', type: 'error', duration: 4000 });
    } finally {
      setTemplateSaving(false);
    }
  }, [templateDraft, templateSaving, saveUserPrompt, showToast]);

  const handleCancelTemplateEdit = useCallback(() => {
    if (!templateDraft) return;
    const list = userPromptEntries['script-template'] ?? [];
    const persisted = list.find((item) => item.id === templateDraft.id);
    if (persisted) {
      // 已保存的条目：还原为持久化版本
      setTemplateDraft({ ...persisted });
    } else {
      // 未保存的新草稿：切回默认 kind 选中
      setActive({ type: 'kind', kind: PROMPT_KINDS[0] });
    }
  }, [templateDraft, userPromptEntries]);

  const handleConfirmDeleteTemplate = useCallback(async () => {
    const id = confirmDeleteTemplateId;
    if (!id) return;
    try {
      await deleteUserPrompt('script-template', id);
      showToast('已删除模板', { type: 'success', duration: 2500 });
      // 删除后切回列表首项或默认 kind
      const listNext = useAIStore.getState().userPromptEntries['script-template'] ?? [];
      if (listNext.length > 0) {
        setActive({
          type: 'user-entry',
          category: 'script-template',
          entryId: listNext[0].id,
        });
      } else {
        setActive({ type: 'kind', kind: PROMPT_KINDS[0] });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, { title: '删除失败', type: 'error', duration: 4000 });
    } finally {
      setConfirmDeleteTemplateId(null);
    }
  }, [confirmDeleteTemplateId, deleteUserPrompt, showToast]);

  /** 口播模板是否未保存（name/description/system/user 与持久化版本不同） */
  const templateDirty = useMemo(() => {
    if (!templateDraft) return false;
    const list = userPromptEntries['script-template'] ?? [];
    const persisted = list.find((item) => item.id === templateDraft.id);
    if (!persisted) {
      // 新草稿：任一字段非默认空即 dirty
      return Boolean(
        templateDraft.name.trim() ||
          templateDraft.description.trim() ||
          templateDraft.system.trim() ||
          (templateDraft.user && templateDraft.user !== '{{rawText}}') ||
          templateDraft.ttsStyle?.trim() ||
          templateDraft.ttsAnnotateHint?.trim(),
      );
    }
    return (
      persisted.name !== templateDraft.name ||
      persisted.description !== templateDraft.description ||
      persisted.system !== templateDraft.system ||
      persisted.user !== templateDraft.user ||
      (persisted.ttsStyle ?? '') !== (templateDraft.ttsStyle ?? '') ||
      (persisted.ttsAnnotateHint ?? '') !== (templateDraft.ttsAnnotateHint ?? '')
    );
  }, [templateDraft, userPromptEntries]);

  return (
    <div className={styles.root}>
      <SettingsPageHeader
        title="提示词配置"
        description="编辑 AI 内容卡片、封面图、Motion 动效以及口播模板的提示词正文；系统会自动保存为合法 YAML。"
      />

      {!hasProject && (
        <Alert
          variant="info"
          description="未打开项目，仅能编辑全局提示词。打开项目后可单独覆盖项目级提示词。"
        />
      )}

      <div className={styles.layout}>
        <Card className={styles.sidebarCard}>
          <CardHeader className={styles.sidebarHeader}>
            <CardTitle>提示词列表</CardTitle>
            <CardDescription>按优先级：项目 &gt; 全局 &gt; 内置默认</CardDescription>
          </CardHeader>
          <CardContent className={styles.sidebarList}>
            {(['project', 'ai-analysis', 'script'] as const).map((group) => (
              <div className={styles.group} key={group}>
                <div className={styles.groupTitle}>{GROUP_LABEL[group]}</div>
                {groupedKinds[group].map((item) => {
                  const isActive =
                    active.type === 'kind' && item.kind === active.kind;
                  const bindingBadge = item.meta.supportsBinding === false
                    ? null
                    : computeBindingBadge(item.kind, scope, aiSettings, projectBindings);
                  return (
                    <div className={styles.kindRow} key={item.kind}>
                      <Button
                        type="button"
                        variant={isActive ? 'secondary' : 'ghost'}
                        size="sm"
                        className={styles.kindButton}
                        onClick={() => setActive({ type: 'kind', kind: item.kind })}
                      >
                        <span>{item.meta.label}</span>
                        <span className={styles.kindBadges}>
                          <Badge
                            variant={SCOPE_BADGE_VARIANT[item.effectiveScope]}
                            size="xs"
                          >
                            {SCOPE_LABEL[item.effectiveScope]}
                          </Badge>
                          {bindingBadge ? (
                            <Badge variant={bindingBadge.variant} size="xs">
                              {bindingBadge.label}
                            </Badge>
                          ) : null}
                        </span>
                      </Button>
                    </div>
                  );
                })}

                {/* 项目统一风格：合成条目，挂在 "project" 大组下 */}
                {group === 'project' && (
                  <div className={styles.kindRow}>
                    <Button
                      type="button"
                      variant={active.type === 'style' ? 'secondary' : 'ghost'}
                      size="sm"
                      className={styles.kindButton}
                      onClick={() => setActive({ type: 'style' })}
                    >
                      <span>项目统一风格</span>
                      <span className={styles.kindBadges}>
                        <Badge
                          variant={
                            scope === 'project'
                              ? projectStylePresetId
                                ? 'success'
                                : 'secondary'
                              : 'info'
                          }
                          size="xs"
                        >
                          {scope === 'project'
                            ? projectStylePresetId
                              ? '项目'
                              : '继承'
                            : '全局'}
                        </Badge>
                      </span>
                    </Button>
                  </div>
                )}

                {/* 口播模板子分区挂在 "script" 大组下 */}
                {group === 'script' && (
                  <div className={styles.subGroup}>
                    <div className={styles.subGroupTitle}>
                      <span className={styles.subGroupLabel}>
                        {scriptTemplateMeta.label}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.subGroupAddBtn}
                        onClick={handleCreateNewTemplate}
                        aria-label="新增口播模板"
                      >
                        <Plus size={12} />
                        新增
                      </Button>
                    </div>

                    {scriptTemplateEntries.length === 0 ? (
                      <div className={styles.entryDescription}>
                        暂无模板，点击上方"新增"创建
                      </div>
                    ) : null}

                    {scriptTemplateEntries.map((entry) => {
                      const isActive =
                        active.type === 'user-entry' &&
                        active.category === 'script-template' &&
                        active.entryId === entry.id;
                      return (
                        <div className={styles.kindRow} key={entry.id}>
                          <Button
                            type="button"
                            variant={isActive ? 'secondary' : 'ghost'}
                            size="sm"
                            className={styles.kindButton}
                            onClick={() => handleSelectTemplate(entry.id)}
                          >
                            <span>{entry.name || '未命名模板'}</span>
                            <span className={styles.kindBadges}>
                              <Badge
                                variant={entry.isBuiltin ? 'outline' : 'info'}
                                size="xs"
                              >
                                {entry.isBuiltin ? '内置' : '自定义'}
                              </Badge>
                            </span>
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ─── 右侧编辑器：根据 active 类型切换 ──────────── */}
        {active.type === 'kind' && activeMeta ? (
          <Card className={styles.editorCard}>
            <CardHeader className={styles.editorHeader}>
              <div className={styles.editorHeaderText}>
                <CardTitle>{activeMeta.label}</CardTitle>
                <CardDescription>{activeMeta.description}</CardDescription>
              </div>
              <Tabs
                value={scope}
                onValueChange={(next) => setScope(next as EditableScope)}
              >
                <TabsList>
                  <TabsTrigger value="global">全局</TabsTrigger>
                  <TabsTrigger value="project" disabled={!hasProject}>
                    当前项目
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>

            <CardContent className={styles.editorBody}>
              {showBindingWarning && bindingError && (
                <div className={styles.warning}>
                  {bindingError.message} —— 请在下方重选 Provider / Model
                </div>
              )}

              {activeMeta.supportsBinding !== false ? (
                <PromptBindingBar
                  scope={scope}
                  kind={active.kind}
                  binding={currentScopeBinding}
                  llmProviders={llmProviders}
                  effectiveProviderId={resolved?.provider?.id ?? null}
                  effectiveModel={resolved?.model ?? null}
                  onChange={(next) => {
                    void handleBindingChange(next);
                  }}
                  showImageBinding={
                    active.kind === 'cover.regeneration' || active.kind === 'card.image'
                  }
                  imageProviders={imageProviders}
                  effectiveImageProviderId={resolved?.imageProvider?.id ?? null}
                  effectiveImageModel={resolved?.imageModel ?? null}
                  onImageChange={(next) => {
                    void handleImageBindingChange(next);
                  }}
                  showVideoBinding={active.kind === 'card.video'}
                  videoProviders={videoProviders}
                  effectiveVideoProviderId={resolved?.videoProvider?.id ?? null}
                  effectiveVideoModel={resolved?.videoModel ?? null}
                  onVideoChange={(next) => {
                    void handleVideoBindingChange(next);
                  }}
                />
              ) : (
                <Alert
                  variant="info"
                  description="这是跨步骤复用的导演规则，不会单独调用模型。系统会自动注入字幕分段规划与 Motion Bible；音效预算、最小间隔、响度和安全区仍由代码硬门禁保证。"
                />
              )}

              {active.kind === 'cards.segment' ? (
                <Field
                  label="段落卡片生成并发数"
                  hint="同时并发生成多少个段落的卡片；信息图（image 卡）的图片生成服务调用嵌套在 worker 内，因此该值也决定信息图并行度。必须 ≥ 1，默认 4。云端模型（如 DeepSeek）可适当调高以提速；若频繁出现 429/限流再下调。"
                >
                  <NumberField
                    value={cardConcurrencyValue}
                    min={1}
                    step={1}
                    disabled={!aiSettings}
                    onChange={(next) => {
                      void handleCardConcurrencyChange(next);
                    }}
                  />
                </Field>
              ) : null}

              {error && <Alert variant="error" description={error} />}

              <div className={styles.editorWrap}>
                <CodeEditor
                  value={content}
                  onChange={setContent}
                  language="text"
                  minHeight="100%"
                  ariaLabel={`${activeMeta.label} 提示词正文编辑器`}
                  variables={activeMeta.variables}
                  placeholder="直接输入提示词正文，无需填写 YAML 字段或缩进"
                />
              </div>

              {activeMeta.variables.length > 0 && (
                <details className={styles.collapsible}>
                  <summary className={styles.collapsibleSummary}>
                    <ChevronRight size={12} className={styles.collapsibleChevron} />
                    <Variable size={12} />
                    <span className={styles.collapsibleTitle}>可用变量</span>
                    <span className={styles.collapsibleMeta}>
                      {activeMeta.variables.length} 个 · 以 {'{{name}}'} 形式插入
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    <div className={styles.varHintGrid}>
                      {activeMeta.variables.map((v) => (
                        <div key={v.name} className={styles.varHintItem}>
                          <code>{`{{${v.name}}}`}</code>
                          <span>— {v.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}

              {activeMeta.lockedContract && (
                <details className={`${styles.collapsible} ${styles.collapsibleLocked}`}>
                  <summary className={styles.collapsibleSummary}>
                    <ChevronRight size={12} className={styles.collapsibleChevron} />
                    <Lock size={12} />
                    <span className={styles.collapsibleTitle}>业务契约</span>
                    <span className={styles.collapsibleMeta}>
                      不可编辑 · 自动拼接到每次请求末尾
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    <div className={styles.lockedReason}>
                      {activeMeta.lockedContract.reason}
                    </div>
                    <pre className={styles.lockedContent}>{activeMeta.lockedContract.content}</pre>
                  </div>
                </details>
              )}

              <div className={styles.statusBar}>
                <Badge variant={isOverride ? SCOPE_BADGE_VARIANT[scope] : 'outline'} size="xs">
                  当前编辑：{SCOPE_LABEL[scope]}
                </Badge>
                <span>{isOverride ? '已存在覆盖文件' : '使用内置默认（保存后才会创建覆盖文件）'}</span>
                {dirty && <Badge variant="warning" size="xs">未保存</Badge>}
              </div>
            </CardContent>

            <CardFooter className={styles.editorFooter}>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={saving || loading || !dirty}
              >
                <Save size={14} />
                保存到 {SCOPE_LABEL[scope]}
              </Button>
              <Button variant="secondary" onClick={handleResetToDefault} disabled={loading}>
                <RotateCcw size={14} />
                重置为内置默认
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmReset(scope)}
                disabled={loading || !isOverride}
              >
                <Trash2 size={14} />
                删除当前 {SCOPE_LABEL[scope]} 覆盖
              </Button>
            </CardFooter>
          </Card>
        ) : null}

        {active.type === 'user-entry' && templateDraft ? (
          <Card className={styles.editorCard}>
            <CardHeader className={styles.editorHeader}>
              <div className={styles.editorHeaderText}>
                <CardTitle>
                  {templateDraft.name.trim() || '未命名模板'}
                  <Badge
                    variant={templateDraft.isBuiltin ? 'outline' : 'info'}
                    size="xs"
                    style={{ marginLeft: 8 }}
                  >
                    {templateDraft.isBuiltin ? '内置' : '自定义'}
                  </Badge>
                </CardTitle>
                <CardDescription>{scriptTemplateMeta.description}</CardDescription>
              </div>
            </CardHeader>

            <CardContent className={styles.editorBody}>
              {hasProject ? (
                <Field
                  label="AI 绑定"
                  hint="仅在当前项目生效；未绑定时使用全局默认 LLM"
                >
                  {aiSettings && templateBindingError && templateCurrentBinding ? (
                    <Alert variant="destructive" className={styles.bindingAlert}>
                      当前绑定已失效：{templateBindingError.message}
                    </Alert>
                  ) : null}
                  <PromptBindingBar
                    scope="project"
                    kind={templateBindingKey ?? ''}
                    binding={templateCurrentBinding}
                    llmProviders={aiSettings?.llmProviders ?? []}
                    effectiveProviderId={templateResolved?.provider?.id ?? null}
                    effectiveModel={templateResolved?.model ?? null}
                    onChange={handleTemplateBindingChange}
                  />
                </Field>
              ) : (
                <Alert variant="info" className={styles.bindingAlert}>
                  AI 绑定需要在打开一个项目后配置（口播模板绑定仅在项目内生效）。
                </Alert>
              )}

              <Field label="名称" required>
                <Input
                  value={templateDraft.name}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, name: e.target.value })
                  }
                  placeholder="如：财经解读"
                />
              </Field>

              <Field label="描述">
                <Input
                  value={templateDraft.description}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, description: e.target.value })
                  }
                  placeholder="一句话描述风格特点"
                />
              </Field>

              <Field label="系统提示词（system）" required>
                <Textarea
                  value={templateDraft.system}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, system: e.target.value })
                  }
                  placeholder="输入完整的写作指令..."
                  rows={12}
                  size="sm"
                  resize="vertical"
                />
              </Field>

              <Field
                label="用户提示词模板（user）"
                hint="会被送入 LLM 的 user 消息；支持 {{rawText}} 占位"
              >
                <Textarea
                  value={templateDraft.user}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, user: e.target.value })
                  }
                  placeholder="{{rawText}}"
                  rows={3}
                  size="sm"
                  resize="vertical"
                />
              </Field>

              <Field
                label="口播演绎人设（MiMo 朗读语气，可留空用默认）"
                hint="向 MiMo TTS 描述该模板专属的朗读风格与角色人设，留空时使用全局默认"
              >
                <Textarea
                  value={templateDraft.ttsStyle ?? ''}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, ttsStyle: e.target.value })
                  }
                  placeholder="例如：用沉稳、专业的财经解说语气朗读，语速适中，重点词语适当加强。"
                  rows={3}
                  size="sm"
                  resize="vertical"
                />
              </Field>

              <Field
                label="打标风格倾向（可留空）"
                hint="智能语气打标时的风格偏好提示，留空时使用默认打标策略"
              >
                <Input
                  value={templateDraft.ttsAnnotateHint ?? ''}
                  onChange={(e) =>
                    setTemplateDraft({ ...templateDraft, ttsAnnotateHint: e.target.value })
                  }
                  placeholder="例如：财经解说、专业沉稳"
                />
              </Field>

              {scriptTemplateMeta.variables.length > 0 && (
                <details className={styles.collapsible}>
                  <summary className={styles.collapsibleSummary}>
                    <ChevronRight size={12} className={styles.collapsibleChevron} />
                    <Variable size={12} />
                    <span className={styles.collapsibleTitle}>可用变量</span>
                    <span className={styles.collapsibleMeta}>
                      {scriptTemplateMeta.variables.length} 个 · 以 {'{{name}}'} 形式插入
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    <div className={styles.varHintGrid}>
                      {scriptTemplateMeta.variables.map((v) => (
                        <div key={v.name} className={styles.varHintItem}>
                          <code>{`{{${v.name}}}`}</code>
                          <span>— {v.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}

              <div className={styles.statusBar}>
                <Badge
                  variant={templateDraft.isBuiltin ? 'outline' : 'info'}
                  size="xs"
                >
                  {templateDraft.isBuiltin ? '内置模板' : '自定义模板'}
                </Badge>
                <span>口播模板的 AI 绑定仅在当前项目生效，未绑定时使用全局默认</span>
                {templateDirty && <Badge variant="warning" size="xs">未保存</Badge>}
              </div>
            </CardContent>

            <CardFooter className={styles.editorFooter}>
              <Button
                variant="primary"
                onClick={handleSaveTemplate}
                disabled={templateSaving || !templateDirty}
              >
                <Save size={14} />
                保存
              </Button>
              <Button
                variant="secondary"
                onClick={handleCancelTemplateEdit}
                disabled={templateSaving || !templateDirty}
              >
                取消
              </Button>

              {/* 内置条目：仅在被覆盖/修改时显示"恢复默认"；恢复即删除自定义覆盖 */}
              {templateDraft.isBuiltin &&
                isBuiltinSeedId('script-template', templateDraft.id) && (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmDeleteTemplateId(templateDraft.id)}
                    disabled={templateSaving}
                  >
                    <RotateCcw size={14} />
                    恢复默认
                  </Button>
                )}

              {/* 自定义条目：提供删除 */}
              {!templateDraft.isBuiltin && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDeleteTemplateId(templateDraft.id)}
                  disabled={templateSaving}
                >
                  <Trash2 size={14} />
                  删除模板
                </Button>
              )}
            </CardFooter>
          </Card>
        ) : null}

        {active.type === 'style' ? (
          <Card className={styles.editorCard}>
            <CardHeader className={styles.editorHeader}>
              <div className={styles.editorHeaderText}>
                <CardTitle>项目统一风格</CardTitle>
                <CardDescription>
                  选择项目统一视觉风格；全局为默认，当前项目可覆盖。
                </CardDescription>
              </div>
              <Tabs
                value={scope}
                onValueChange={(next) => setScope(next as EditableScope)}
              >
                <TabsList>
                  <TabsTrigger value="global">全局</TabsTrigger>
                  <TabsTrigger value="project" disabled={!hasProject}>
                    当前项目
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>

            <CardContent className={styles.editorBody}>
              {scope === 'project' && !hasProject ? (
                <Alert
                  variant="info"
                  description="未打开项目，无法设置项目级风格。打开项目后可单独覆盖全局默认风格。"
                />
              ) : (
                <>
                  {scope === 'project' && (
                    <div className={styles.statusBar}>
                      <Button
                        type="button"
                        variant={!projectStylePresetId ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => {
                          void setProjectStylePresetId(undefined);
                        }}
                      >
                        跟随全局默认
                      </Button>
                      <span>
                        {projectStylePresetId
                          ? '当前项目已覆盖全局默认风格'
                          : '当前项目跟随全局默认风格'}
                      </span>
                    </div>
                  )}
                  <StyleLibraryPanel
                    facetHint="motion"
                    value={
                      scope === 'project'
                        ? projectStylePresetId ?? ''
                        : resolveStylePresetId({ global: aiSettings?.defaultStylePresetId })
                    }
                    onChange={(id) => {
                      if (scope === 'project') void setProjectStylePresetId(id);
                      else void persistGlobalStyle(id);
                    }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmReset !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmReset(null);
        }}
        title={`删除${confirmReset ? SCOPE_LABEL[confirmReset] : ''}覆盖`}
        description={
          <p>
            将删除当前 prompt 在 <strong>{confirmReset ? SCOPE_LABEL[confirmReset] : ''}</strong> 范围内的覆盖文件，回退到上层（项目 → 全局 → 内置默认）。此操作不可撤销。
          </p>
        }
        confirmText="确认删除"
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={handleConfirmDeleteOverride}
      />

      <ConfirmDialog
        open={confirmDeleteTemplateId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteTemplateId(null);
        }}
        title={
          confirmDeleteTemplateId &&
          isBuiltinSeedId('script-template', confirmDeleteTemplateId)
            ? '恢复默认模板'
            : '删除模板'
        }
        description={
          <p>
            {confirmDeleteTemplateId &&
            isBuiltinSeedId('script-template', confirmDeleteTemplateId)
              ? '将删除你对该内置模板的自定义覆盖，恢复为内置默认内容。此操作不可撤销。'
              : '将删除该自定义模板，其他项目中若仍引用会回退到默认模板。此操作不可撤销。'}
          </p>
        }
        confirmText={
          confirmDeleteTemplateId &&
          isBuiltinSeedId('script-template', confirmDeleteTemplateId)
            ? '恢复默认'
            : '确认删除'
        }
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={handleConfirmDeleteTemplate}
      />
    </div>
  );
}
