import { ipcMain, app, dialog, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentConfig, normalizeAgentId } from './config';
import { BinaryManager } from './binary-manager';
import { RuntimeRegistry } from '../agent-runtime/runtime-registry';
import { AgentSession } from '../agent-runtime/session';
import { resolveBundledEntry } from '../agent-runtime/bundled-runtime';
import { getAgentDef } from '../agent-runtime/registry';
import { runPreflight } from './preflight';
import { writePiConfig } from '../agent-runtime/pi-config-seed';
import { buildPiModelOptions } from '../agent-runtime/pi-provider-projection';
import { defaultAISettings, loadFullHeadlessAISettings } from '../pipeline/headless-settings';
import type { PermissionPolicy, PromptInputBlock, ResolvedAgentSkill } from './types';
import { ensureProjectAgentContracts } from './contract-sync';
import { SkillRegistry } from '../agent-skills/registry';
import { AGENT_SKILLS_DIRNAME } from '../agent-skills/constants';
import { buildInjectionText } from '../agent-skills/inject';

const CONFIG_PATH = path.join(os.homedir(), '.lingji', 'agent-config.json');

/** 解析内置入口的统一助手（用于 staged 路径解析，如注入 LINGJI_CLI）。 */
function resolvePiEntry(rel: string): string | null {
  return resolveBundledEntry(rel, {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
  });
}

const config = new AgentConfig(CONFIG_PATH);
const binaryManager = new BinaryManager();
// pi 现以进程内 SDK 运行（见 agent-runtime/pi-inprocess.ts），无需注入子进程依赖。
// agentDir 经 env.PI_CODING_AGENT_DIR 透传（见 connectRuntime），AgentSession 从中解析。
const runtimeRegistry = new RuntimeRegistry({
  binaryManager,
  createSession: () => new AgentSession(),
});

// pi 配置目录：投影后的 provider settings/models 写到这里，并通过
// PI_CODING_AGENT_DIR 指向它；prompt-templates 也复制到此目录供 pi 自动发现。
const PI_CONFIG_DIR = path.join(os.homedir(), '.lingji', 'pi-agent');

// 内置 skill：种子在应用资源 resources/agent-skills，运行时复制到 ~/.lingji/agent-skills。
// app.getAppPath() 在 dev 指向仓库根，在打包指向 app.asar（fs 读 asar 可用）。
const skillRegistry = new SkillRegistry({
  seedRoot: path.join(app.getAppPath(), 'resources', AGENT_SKILLS_DIRNAME),
  targetRoot: path.join(os.homedir(), '.lingji', AGENT_SKILLS_DIRNAME),
});

interface RuntimeConnectPayload {
  conversationId: number;
  projectDir: string;
  sessionId?: string | null;
  agentType?: string;
}

export function registerAgentIpc(getMainWindow: () => BrowserWindow | null): void {
  // 启动时确保 nvm/fnm/volta 的 node 在 PATH 中
  binaryManager.ensureNodeInPath();

  // 启动自检：按 version 强制同步内置 skill 种子 → 用户目录（种子版本号变更即覆盖，
  // 删除已移除的文件）。不阻塞 IPC 注册，失败由 SkillRegistry 内部记录。
  void skillRegistry.ensureBundled();

  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    getMainWindow()?.webContents.send(channel, ...args);
  };

  async function connectRuntime(payload: RuntimeConnectPayload): Promise<void> {
    const configData = await config.load();
    const agentId = normalizeAgentId(payload.agentType);
    const def = getAgentDef(agentId);
    const agentEntry = configData.agents[agentId];
    const policy = configData.permissionPolicy ?? 'tiered';

    // 生成/导出经注入的 lingji CLI（LINGJI_CLI）驱动 App；文本类改动
    // （script.md/original.md/project.json）走 file-first 契约。
    // 同步 file-first 编辑契约要点到 CLAUDE/AGENTS/GEMINI.md（独立 marker），agent 据此操作编辑器。
    await ensureProjectAgentContracts(payload.projectDir);

    // 构建 env：pi 不代管凭证（凭证经 provider 投影写入 pi 配置目录），仅透传用户 envText。
    const env: Record<string, string> = {};

    // 注入 LINGJI_CLI：指向打包内 lingji CLI 入口（dist-cli/lingji.mjs）。
    // skill 用 `node "$LINGJI_CLI" <cmd>` 直接驱动运行中的 App —— CLI 内部读
    // ~/.lingji/control-endpoint.json 连本地控制服务（含 token）。
    // dev 解析到仓库 dist-cli；打包解析到 app.asar.unpacked/dist-cli。
    const lingjiCli = resolvePiEntry('dist-cli/lingji.mjs');
    if (lingjiCli) env.LINGJI_CLI = lingjiCli;

    // pi：投影 App AISettings → pi 配置目录（settings.json + models.json），
    // 并把 prompt-templates 复制进去供 pi 自动发现；最后用 PI_CODING_AGENT_DIR 指向它。
    if (agentId === 'pi') {
      try {
        const ai = await loadFullHeadlessAISettings(app.getPath('userData'));
        await writePiConfig(PI_CONFIG_DIR, ai);
      } catch (err) {
        console.warn('[pi] 写配置失败，使用空 provider:', err);
        try {
          await writePiConfig(PI_CONFIG_DIR, defaultAISettings());
        } catch {
          // 仍失败则 pi 无 provider 配置运行
        }
      }
      // 首次安装时种子 prompt-templates；已存在则跳过，不覆盖用户改动。
      const destTemplates = path.join(PI_CONFIG_DIR, 'prompt-templates');
      try {
        if (!existsSync(destTemplates)) {
          const srcTemplates = path.join(app.getAppPath(), 'resources', 'pi-config', 'prompt-templates');
          await fs.cp(srcTemplates, destTemplates, { recursive: true });
        }
      } catch (err) {
        console.warn('[pi] 种子 prompt-templates 失败:', err);
      }
      env.PI_CODING_AGENT_DIR = PI_CONFIG_DIR;
    }

    // 解析 envText（所有 agent 通用）
    if (agentEntry?.envText) {
      for (const line of agentEntry.envText.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
    }

    // 解析当前 agent 启用的内置 skills（连接期 pi --skill / codex --add-dir 用）
    let resolvedSkills: ResolvedAgentSkill[] = [];
    try {
      resolvedSkills = await skillRegistry.resolveForAgent(agentId, agentEntry?.skills);
    } catch (err) {
      console.warn('[agent-skills] resolveForAgent 失败:', err);
    }

    await runtimeRegistry.connect({
      conversationId: payload.conversationId,
      agentType: agentId,
      projectDir: payload.projectDir,
      model: agentEntry?.model || def?.defaultModel,
      sessionId: payload.sessionId ?? null,
      env,
      permissionPolicy: policy,
      skills: resolvedSkills,
    });
  }

  // 连接时同步当前权限策略到 runtime
  void config.load().then((data) => {
    if (data.permissionPolicy) runtimeRegistry.setPermissionPolicy(data.permissionPolicy);
  });

  // RuntimeRegistry 仅 emit 'status'/'event'，转发到 Renderer（通道契约不变）
  runtimeRegistry.on('status', ({ conversationId, status }) => {
    sendToRenderer('agent:runtime-status', { conversationId, status });
  });
  runtimeRegistry.on('event', ({ conversationId, event }) => {
    sendToRenderer('agent:runtime-event', { conversationId, event });
  });

  ipcMain.handle('agent:connect-runtime', async (_event, payload: RuntimeConnectPayload) => {
    await connectRuntime(payload);
  });

  ipcMain.handle('agent:disconnect-runtime', async (_event, conversationId: number) => {
    runtimeRegistry.disconnect(conversationId);
  });

  ipcMain.handle(
    'agent:send-prompt-runtime',
    async (
      _event,
      conversationId: number,
      contents: unknown[],
      opts?: { model?: string; reasoning?: string; skillIds?: string[] },
    ) => {
      const finalContents = await maybeInjectSkills(conversationId, contents, opts?.skillIds);
      await runtimeRegistry.sendPrompt(conversationId, finalContents, {
        model: opts?.model,
        reasoning: opts?.reasoning,
      });
    },
  );

  ipcMain.handle('agent:cancel-turn-runtime', async (_event, conversationId: number) => {
    runtimeRegistry.cancelTurn(conversationId);
  });

  ipcMain.handle('agent:set-mode-runtime', async (_event, conversationId: number, modeId: string) => {
    await runtimeRegistry.setMode(conversationId, modeId);
  });

  ipcMain.handle('agent:set-config-option-runtime', async (_event, conversationId: number, configId: string, valueId: string) => {
    await runtimeRegistry.setConfigOption(conversationId, configId, valueId);
  });

  ipcMain.handle('agent:respond-permission-runtime', async (_event, conversationId: number, requestId: string, optionId: string) => {
    await runtimeRegistry.respondPermission(conversationId, requestId, optionId);
  });

  // 配置管理
  ipcMain.handle('agent:get-config', () => config.load());
  ipcMain.handle('agent:save-config', async (_event, data) => config.save(data));
  // 立即持久化全局激活 agent（不连带保存表单内其它未保存的草稿编辑）。
  ipcMain.handle('agent:set-active-agent', async (_event, agentId: string) => {
    const data = await config.load();
    data.activeAgentId = normalizeAgentId(agentId);
    await config.save(data);
  });
  ipcMain.handle('agent:get-api-key', async (_event, agentId: string) => config.getApiKey(agentId));
  ipcMain.handle('agent:set-api-key', async (_event, agentId: string, key: string) =>
    config.setApiKey(agentId, key),
  );
  ipcMain.handle('agent:get-permission-policy', async () => {
    const data = await config.load();
    return data.permissionPolicy;
  });
  ipcMain.handle('agent:set-permission-policy', async (_event, policy: PermissionPolicy) => {
    const data = await config.load();
    data.permissionPolicy = policy;
    await config.save(data);
    // 同步到所有已连接的运行时，使策略即时生效
    runtimeRegistry.setPermissionPolicy(policy);
  });

  // 预检与安装
  ipcMain.handle('agent:run-preflight', (_e, agentId?: string) =>
    runPreflight(binaryManager, config, agentId ?? 'pi'),
  );

  // 模型列表按 provider 模式生成：从 App 的 AISettings.llmProviders 展开
  // （与 writePiConfig 投影到 models.json 的 provider key 对齐），不再调用
  // `pi --list-models` 或写死兜底。一个可投影 provider 都没有时仅返回 'default'。
  ipcMain.handle('agent:list-models', async () => {
    try {
      const ai = await loadFullHeadlessAISettings(app.getPath('userData'));
      const models = buildPiModelOptions(ai);
      return { models, source: models.length > 1 ? ('live' as const) : ('fallback' as const) };
    } catch (err) {
      console.warn('[pi] list-models 读取 provider 失败:', err);
      return { models: [{ id: 'default', label: '默认' }], source: 'fallback' as const };
    }
  });
  // 列出某 agent 的内置 skills（renderer 设置页 / composer 补全用）
  ipcMain.handle('agent:list-skills', async (_e, agentId?: string) => {
    const id = normalizeAgentId(agentId ?? 'pi');
    try {
      const cfg = await config.load();
      const entry = cfg.agents[id];
      return await skillRegistry.resolveForAgent(id, entry?.skills);
    } catch (err) {
      console.warn('[agent-skills] list-skills 失败:', err);
      return [] as ResolvedAgentSkill[];
    }
  });

  // 用户从本地文件夹导入 skill 库：主进程弹目录选择器 → 复制进用户 skill 目录。
  ipcMain.handle('agent:add-skill', async () => {
    const win = getMainWindow();
    const dialogOpts = {
      title: '选择 Skill 文件夹（需包含 SKILL.md）',
      properties: ['openDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    try {
      const addedId = await skillRegistry.addSkillFromDirectory(result.filePaths[0]);
      return { canceled: false as const, addedId };
    } catch (err) {
      return { canceled: false as const, error: (err as Error).message };
    }
  });

  // 删除用户导入的 skill（内置不可删，registry 内部校验）。
  ipcMain.handle('agent:remove-skill', async (_e, skillId: string) => {
    try {
      await skillRegistry.removeSkill(skillId);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // skill 详情模态：读目录树。失败返回 null，由前端展示占位。
  ipcMain.handle('agent:read-skill-tree', async (_e, skillId: string) => {
    try {
      return await skillRegistry.readSkillTree(skillId);
    } catch (err) {
      console.warn('[agent-skills] read-skill-tree 失败:', err);
      return null;
    }
  });

  // skill 详情模态：读单文件（已做大小 / 二进制 / 路径穿越保护）。
  ipcMain.handle('agent:read-skill-file', async (_e, skillId: string, relPath: string) => {
    try {
      return await skillRegistry.readSkillFile(skillId, relPath);
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // 在 Finder / 资源管理器中打开 skill 目录；不传 id 则打开 skill 库根目录。
  ipcMain.handle('agent:open-skill-dir', async (_e, skillId?: string) => {
    const target = skillId
      ? skillRegistry.getSkillRootPath(skillId)
      : skillRegistry.getSkillsRoot();
    await fs.mkdir(target, { recursive: true }).catch(() => {});
    const err = await shell.openPath(target);
    return { ok: err === '', error: err || undefined };
  });
}

/**
 * 若本轮带 skillIds：main 二次校验（当前 agent 已启用 + skill 存在），
 * 读取主 SKILL.md 拼到 prompt 前。任何校验失败 / 读取失败都安静降级为原始消息。
 */
async function maybeInjectSkills(
  conversationId: number,
  contents: unknown[],
  requestedIds: string[] | undefined,
): Promise<unknown[]> {
  if (!requestedIds || requestedIds.length === 0) return contents;
  const snapshot = runtimeRegistry.get(conversationId);
  if (!snapshot) return contents;

  let enabled: ResolvedAgentSkill[] = [];
  try {
    const cfg = await config.load();
    const entry = cfg.agents[snapshot.agentType];
    const resolved = await skillRegistry.resolveForAgent(snapshot.agentType, entry?.skills);
    enabled = resolved.filter((s) => s.enabled && s.status === 'available');
  } catch {
    return contents;
  }

  // requestedIds 已是 renderer 解析出的裸 id（不含 $）；此处仅去重并校验当前
  // agent 是否启用，未启用 / 未知 id 一律丢弃。
  const enabledIds = new Set(enabled.map((s) => s.id));
  const seenIds = new Set<string>();
  const valid = requestedIds.filter((id) => {
    if (seenIds.has(id) || !enabledIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  if (valid.length === 0) return contents;

  const injected: { id: string; markdown: string }[] = [];
  for (const id of valid) {
    try {
      injected.push({ id, markdown: await skillRegistry.readSkillMarkdown(id) });
    } catch (err) {
      console.warn(`[agent-skills] 读取 ${id} SKILL.md 失败:`, err);
    }
  }
  if (injected.length === 0) return contents;

  const blocks = contents as PromptInputBlock[];
  const userText = blocks
    .filter((b): b is PromptInputBlock & { type: 'text' } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n');
  const nonText = blocks.filter((b) => !b || (b as { type?: string }).type !== 'text');
  const injectedText = buildInjectionText(injected, userText);
  return [{ type: 'text', text: injectedText } as PromptInputBlock, ...nonText];
}
