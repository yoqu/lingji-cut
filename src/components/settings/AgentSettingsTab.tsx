import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
  Hand,
  ShieldCheck,
  AlertTriangle,
  Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AgentConfigData,
  AgentEntry,
  ResolvedAgentSkill,
} from '../../../electron/acp/types';
import { getAgentPresentation, DEFAULT_AGENT_ID } from '../../lib/agent-presentation';
import {
  Badge,
  Button,
  ConfirmDialog,
  Divider,
  PillGroup,
  SaveButton,
  SettingsPageHeader,
  Switch,
} from '../../ui';
import { SkillDetailModal } from './SkillDetailModal';
import styles from './AgentSettingsTab.module.css';

/** 审批模式三态（与输入框底栏 pill 对齐）。 */
const APPROVAL_MODES: {
  id: NonNullable<AgentConfigData['permissionPolicy']>;
  label: string;
  description: string;
  Icon: LucideIcon;
  caution?: boolean;
}[] = [
  { id: 'always_ask', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问', Icon: Hand },
  { id: 'tiered', label: '替我审批', description: '仅对检测到的风险操作请求批准', Icon: ShieldCheck },
  { id: 'auto_approve', label: '完全访问', description: '可不受限制地访问互联网和您电脑上的任何文件', Icon: AlertTriangle, caution: true },
];

/** skill 列表行的简介上限：超出截断（来自 SKILL.md frontmatter description）。 */
const DESC_MAX = 100;
function truncateDesc(text: string): string {
  const t = (text ?? '').trim();
  return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX)}…` : t;
}

/** pi SDK 化后唯一 agent；默认条目仅保留运行期字段。 */
function makeDefaultEntry(): AgentEntry {
  return {
    enabled: true,
    version: '',
    sortOrder: 0,
    skills: [{ id: 'lingji-video-workflow', enabled: true }],
  };
}

export function AgentSettingsTab() {
  const [config, setConfig] = useState<AgentConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [skills, setSkills] = useState<ResolvedAgentSkill[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ResolvedAgentSkill | null>(null);
  const [detailSkill, setDetailSkill] = useState<ResolvedAgentSkill | null>(null);

  const profile = getAgentPresentation(DEFAULT_AGENT_ID);
  const agent = config?.agents?.[DEFAULT_AGENT_ID] ?? makeDefaultEntry();

  const loadSkills = useCallback(async () => {
    if (typeof window.agentAPI?.listSkills !== 'function') return;
    try {
      setSkills(await window.agentAPI.listSkills(DEFAULT_AGENT_ID));
    } catch {
      setSkills([]);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    if (typeof window.agentAPI === 'undefined') return;
    setConfig(await window.agentAPI.getConfig());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.agentAPI === 'undefined') return;
    void loadConfig();
    void loadSkills();
  }, [loadConfig, loadSkills]);

  const updateAgent = useCallback(
    (patch: Partial<AgentEntry>) => {
      if (!config) return;
      setConfig({
        ...config,
        agents: { ...config.agents, [DEFAULT_AGENT_ID]: { ...agent, ...patch } },
      });
    },
    [agent, config],
  );

  // 审批模式：用专用 IPC 即时落盘并同步运行时（与输入框 pill 共享同一全局策略）。
  const permissionPolicy = config?.permissionPolicy ?? 'tiered';
  const handlePolicyChange = useCallback(
    (policy: AgentConfigData['permissionPolicy']) => {
      setConfig((prev) => (prev ? { ...prev, permissionPolicy: policy } : prev));
      void window.agentAPI?.setPermissionPolicy?.(policy);
    },
    [],
  );

  // 切换 skill 启用态：写回 config.agents.pi.skills，由「保存配置」落盘。
  const toggleSkill = useCallback(
    (skillId: string, enabled: boolean) => {
      if (!config) return;
      const current = agent.skills ?? [];
      const has = current.some((s) => s.id === skillId);
      const nextSkills = has
        ? current.map((s) => (s.id === skillId ? { ...s, enabled } : s))
        : [...current, { id: skillId, enabled }];
      updateAgent({ skills: nextSkills });
    },
    [agent.skills, config, updateAgent],
  );

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    await window.agentAPI.saveConfig(config);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddSkill = async () => {
    if (typeof window.agentAPI?.addSkill !== 'function') return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.agentAPI.addSkill();
      if (res.canceled) return;
      if (res.error) {
        setNotice(`导入失败：${res.error}`);
        return;
      }
      setNotice(`已导入 skill：${res.addedId}`);
      await loadSkills();
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveSkill = async (skill: ResolvedAgentSkill) => {
    setRemoveTarget(null);
    if (typeof window.agentAPI?.removeSkill !== 'function') return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.agentAPI.removeSkill(skill.id);
      if (!res.ok) {
        setNotice(`删除失败：${res.error ?? '未知错误'}`);
        return;
      }
      // 同步从配置里移除该 skill 的开关项（避免残留），并落盘。
      if (config) {
        const next = (agent.skills ?? []).filter((s) => s.id !== skill.id);
        const nextConfig = {
          ...config,
          agents: { ...config.agents, [DEFAULT_AGENT_ID]: { ...agent, skills: next } },
        };
        setConfig(nextConfig);
        await window.agentAPI.saveConfig(nextConfig);
      }
      await loadSkills();
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return <div className={styles.loading}>加载中...</div>;
  }

  return (
    <div className={styles.container}>
      <SettingsPageHeader
        title="AI Agent"
        description="内置 Pi（SDK 模式）"
        leading={<Bot size={24} className={styles.agentIcon} />}
        actions={<Badge variant="secondary">{profile.displayName}</Badge>}
      />

      <p className={styles.guideText}>
        Pi 以内置 SDK 运行，无需单独安装。对话使用的模型与凭证统一在「AI 生成服务」设置中配置，
        会话内可在输入框下方切换具体模型与思考程度。
      </p>

      <Divider label="审批模式" />
      <p className={styles.guideText}>
        控制 Pi 执行工具调用时的批准方式。该设置全局生效，并与对话输入框底部的审批开关实时同步。
      </p>
      <PillGroup
        direction="vertical"
        fullWidth
        value={permissionPolicy}
        className={styles.approvalGroup}
        itemClassName={styles.approvalOption}
        onChange={handlePolicyChange}
        items={APPROVAL_MODES.map((mode) => {
          const Icon = mode.Icon;
          return {
            value: mode.id,
            label: <>
              <Icon size={16} className={mode.caution ? styles.cautionIcon : styles.approvalIcon} />
              <span className={styles.approvalCopy}>
                <span className={styles.approvalLabel}>{mode.label}</span>
                <span className={styles.approvalDescription}>{mode.description}</span>
              </span>
              {mode.id === permissionPolicy ? <Check size={16} className={styles.selectedIcon} /> : null}
            </>,
          };
        })}
      />

      <Divider label="Skills" />
      <p className={styles.guideText}>
        管理 Pi 可调用的 skill 库。对话中输入 <code>$</code> 或 <code>+</code> 可弹出菜单选择已启用的 skill。
      </p>

      <div className={styles.statusHeader}>
        <h3 className={styles.sectionTitle}>已安装 Skill</h3>
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leftIcon={<FolderOpen size={14} />}
            onClick={() => void window.agentAPI?.openSkillDir?.()}
          >
            打开 Skill 目录
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leftIcon={<FolderPlus size={14} />}
            onClick={handleAddSkill}
            disabled={busy}
          >
            添加 Skill 库…
          </Button>
          <Button.Icon
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadSkills()}
            disabled={busy}
            aria-label="刷新 skill 列表"
          >
            <RefreshCw size={14} />
          </Button.Icon>
        </div>
      </div>

      {notice ? <p className={styles.guideText}>{notice}</p> : null}

      {skills.length === 0 ? (
        <p className={styles.guideText}>暂无可用 skill。点击「添加 Skill 库…」从本地文件夹导入。</p>
      ) : (
        skills.map((skill) => {
          const isBuiltin = skill.source === 'builtin';
          // 内置强制启用；用户 skill 取配置（缺省默认启用）。
          const cfgEnabled = isBuiltin
            ? true
            : (agent.skills?.find((s) => s.id === skill.id)?.enabled ?? skill.enabled);
          return (
            <div key={skill.id} className={styles.skillRow}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                fullWidth
                className={styles.skillInfo}
                onClick={() => setDetailSkill(skill)}
                aria-label={`查看 ${skill.displayName} 详情`}
              >
                <span className={styles.skillTitleRow}>
                  <span className={styles.skillName}>{skill.displayName}</span>
                  <Badge variant={isBuiltin ? 'info' : 'secondary'}>
                    {isBuiltin ? '内置·常驻' : '用户'}
                  </Badge>
                  {skill.status !== 'available' ? (
                    <Badge variant="destructive">
                      {skill.status === 'missing' ? '缺失' : '配置错误'}
                    </Badge>
                  ) : null}
                </span>
                {skill.description ? (
                  <span className={styles.skillDesc}>{truncateDesc(skill.description)}</span>
                ) : null}
              </Button>
              <div className={styles.skillActions}>
                <Switch
                  checked={cfgEnabled}
                  disabled={isBuiltin}
                  onChange={(next) => toggleSkill(skill.id, next)}
                  aria-label={`${skill.displayName} 启用开关`}
                  title={isBuiltin ? '内置 skill 强制启用，不可关闭' : undefined}
                />
                {skill.source === 'user' ? (
                  <Button.Icon
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveTarget(skill)}
                    disabled={busy}
                    aria-label={`删除 ${skill.displayName}`}
                  >
                    <Trash2 size={14} />
                  </Button.Icon>
                ) : null}
              </div>
            </div>
          );
        })
      )}

      <div className={styles.actionsRow}>
        <div className={styles.actionsSpacer} />
        <SaveButton
          onClick={handleSave}
          saving={saving}
          saved={saved}
          disabled={busy}
          defaultLabel="保存配置"
        />
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`删除 skill「${removeTarget?.displayName ?? ''}」？`}
        description="将从用户 skill 目录移除该文件夹，可稍后重新导入。"
        confirmText="确认删除"
        confirmVariant="destructive"
        onConfirm={() => {
          if (removeTarget) void handleRemoveSkill(removeTarget);
        }}
      />

      <SkillDetailModal skill={detailSkill} onClose={() => setDetailSkill(null)} />
    </div>
  );
}
