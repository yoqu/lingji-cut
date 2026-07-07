import path from 'node:path';
import { z } from 'zod';
import type { ToolRegistrar } from '../../control/registry';
import { getPipelineService } from '..';
import {
  createProject,
  openProject,
  getProjectState,
  getSettings,
  updateSettings,
} from './project-tools';
import { buildTaskTools } from './task-tools';
import { getActiveProjectPath } from '../context';
import { loadRecentProjects } from '../../recent-projects';
import { registerGenerationTools } from '../headless-generation';
import { registerCardTools } from '../card-tools';
import {
  acquireAiEditLock,
  releaseAiEditLock,
  heartbeatAiEditLock,
  getAiEditLockStatus,
} from '../../ai-edit/session-lock';

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string, code?: string) {
  const payload: Record<string, unknown> = { error: message };
  if (code) payload.code = code;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function pipelineErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function pipelineErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function registerPipelineMcpTools(
  server: ToolRegistrar,
  getMainWindow: () => import('electron').BrowserWindow | null,
  getUserDataPath: () => string,
): void {
  const taskTools = buildTaskTools(getPipelineService());

  server.registerTool(
    'lingji_create_project',
    {
      title: '创建工程',
      description:
        '在指定路径创建一个空的灵机项目骨架（project.json/original.md/covers/ai-cards/configs/prompts）。目标目录必须不存在或为空。',
      inputSchema: {
        path: z.string().describe('项目目录绝对路径'),
        options: z
          .object({
            name: z.string().optional(),
            meta: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      },
    },
    async ({ path: p, options }) => {
      try {
        return jsonResult(await createProject({ path: p, options }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_open_project',
    {
      title: '打开工程',
      description:
        '校验项目目录是否合法；若应用窗口在运行，则切换到该项目（复用最近项目打开路径）。',
      inputSchema: { path: z.string().describe('项目目录路径') },
    },
    async ({ path: p }) => {
      try {
        const result = await openProject({ path: p });
        // 校验通过后，通知运行中的窗口切换到该项目。
        // 复用原生「打开最近项目」走的 menu-action 通道，让 Renderer 走完整的 openProject 流程
        // （loadProject 会 setActiveProjectPath，UI 也会导航到对应页面）。
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('menu-action', {
            type: 'open-recent-project',
            projectDir: path.resolve(p),
          });
        }
        return jsonResult(result);
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_get_project_state',
    {
      title: '查询工程状态',
      description:
        '返回当前项目素材产物推导状态：has_original / has_script / has_audio / has_subtitles / has_analysis / has_covers / has_cards / has_timeline / last_export。',
      inputSchema: {
        projectPath: z.string().describe('项目目录路径'),
      },
    },
    async ({ projectPath }) => {
      try {
        return jsonResult(await getProjectState({ projectPath }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_get_settings',
    {
      title: '查询应用默认设置',
      description:
        '返回 Provider/模型/TTS/导出/提示词绑定的默认值（不含 API Key 等敏感字段）。',
    },
    async () => {
      try {
        return jsonResult(await getSettings({ userDataPath: getUserDataPath() }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_update_settings',
    {
      title: '更新应用默认设置',
      description:
        '白名单字段写入全局设置（默认 Provider/模型、TTS 参数）；拒绝密钥类字段。已打开的设置页需重新进入后可见。',
      inputSchema: {
        updates: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe('要更新的字段键值对（仅白名单字段生效）'),
      },
    },
    async ({ updates }) => {
      try {
        return jsonResult(await updateSettings({ userDataPath: getUserDataPath(), updates }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_get_task_status',
    {
      title: '查询任务状态',
      description: '按 taskId 查询 PipelineTask 完整对象。',
      inputSchema: { taskId: z.string().describe('任务 ID') },
    },
    async ({ taskId }) => {
      try {
        return jsonResult(await taskTools.getTaskStatus({ taskId }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_cancel_task',
    {
      title: '取消任务',
      description: '尝试取消运行中的 PipelineTask；不可取消时返回 not_cancelable 错误码。',
      inputSchema: { taskId: z.string().describe('任务 ID') },
    },
    async ({ taskId }) => {
      try {
        return jsonResult(await taskTools.cancelTask({ taskId }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_list_tasks',
    {
      title: '列出任务',
      description: '列出在跑或 24h 内终态的 PipelineTask；可按 projectPath 过滤。',
      inputSchema: {
        projectPath: z.string().optional().describe('按项目路径过滤（可选）'),
      },
    },
    async ({ projectPath }) => {
      try {
        return jsonResult(await taskTools.listTasks({ projectPath }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_get_active_project',
    {
      title: '查询当前活动项目',
      description:
        '返回应用当前打开/活动的项目目录路径（由渲染进程 load-project 设置）；无活动项目时返回 null。CLI 默认项目即取此值。',
    },
    async () => {
      try {
        return jsonResult({ projectPath: getActiveProjectPath() });
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_list_recent_projects',
    {
      title: '列出最近项目',
      description:
        '返回最近打开过的项目列表（每项含 path/name/lastOpenedAt）；已不存在的项目目录会被过滤。',
    },
    async () => {
      try {
        return jsonResult(await loadRecentProjects(getUserDataPath()));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_edit_lock',
    {
      title: '锁定编辑界面',
      description:
        '让运行中的灵机剪影进入 AI 编辑锁定状态，并写入兼容锁文件。锁定期间内容编辑界面不可操作，AI 面板仍可查看。',
      inputSchema: {
        projectPath: z.string().optional().describe('项目目录路径；为空时使用当前活动项目'),
        scope: z.enum(['video', 'script']).describe('锁定范围'),
        owner: z.string().optional().describe('锁拥有者，默认 agent'),
        reason: z.string().optional().describe('锁定原因，供 UI 展示'),
        ttlMs: z.number().optional().describe('锁有效期毫秒；默认 120000'),
      },
    },
    async ({ projectPath, scope, owner, reason, ttlMs }) => {
      try {
        return jsonResult(await acquireAiEditLock({ projectPath, scope, owner, reason, ttlMs }));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_edit_unlock',
    {
      title: '解除编辑界面锁定',
      description: '解除 AI 编辑锁定状态，并删除兼容锁文件。',
      inputSchema: { projectPath: z.string().optional().describe('项目目录路径；为空时使用当前活动项目') },
    },
    async ({ projectPath }) => {
      try {
        return jsonResult(await releaseAiEditLock(projectPath));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_edit_heartbeat',
    {
      title: '刷新编辑界面锁',
      description: '刷新 AI 编辑锁心跳，长时间编辑时使用。',
      inputSchema: { projectPath: z.string().optional().describe('项目目录路径；为空时使用当前活动项目') },
    },
    async ({ projectPath }) => {
      try {
        return jsonResult(await heartbeatAiEditLock(projectPath));
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  server.registerTool(
    'lingji_edit_lock_status',
    {
      title: '查询编辑界面锁',
      description: '返回当前 AI 编辑锁状态。',
    },
    async () => {
      try {
        return jsonResult(getAiEditLockStatus());
      } catch (err) {
        return errorResult(pipelineErrorMessage(err), pipelineErrorCode(err));
      }
    },
  );

  registerGenerationTools(server, getMainWindow, getUserDataPath);
  registerCardTools(server, getMainWindow, getUserDataPath);
}
