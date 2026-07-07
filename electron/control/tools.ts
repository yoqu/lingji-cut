/**
 * MCP 工具定义与处理器
 * 所有工具通过 IPC 与渲染进程通信，实现编辑器状态查询与操作
 */
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { ToolRegistrar } from './registry';
import { getVideoImportService } from '../video-import/import-service';
import { registerPipelineMcpTools } from '../pipeline/tools/register';
import { registerPublishTools } from '../publish/tools';

// ─── 默认超时（毫秒） ─────────────────────────────────────
const DEFAULT_TIMEOUT = 30_000;

// ─── 日志辅助 ─────────────────────────────────────────────

/** 截断字符串，用于日志摘要 */
function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/** 生成参数摘要（过滤长字段） */
function paramSummary(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 100) {
      out[k] = truncate(v, 100);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── IPC 请求辅助函数 ─────────────────────────────────────

/**
 * 向渲染进程发送 IPC 请求并等待响应
 * @param win 主窗口实例
 * @param channel 目标 IPC 通道
 * @param payload 请求负载
 * @param timeout 超时毫秒数
 */
function ipcRequest<T>(
  win: BrowserWindow,
  channel: string,
  payload: Record<string, unknown> = {},
  timeout = DEFAULT_TIMEOUT,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const replyChannel = `${channel}:reply:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const timer = setTimeout(() => {
      // 超时后移除监听，避免泄漏
      ipcMain.removeHandler(replyChannel);
      reject(new Error(`IPC 请求超时（${timeout}ms）: ${channel}`));
    }, timeout);

    ipcMain.handleOnce(replyChannel, (_event, result: T) => {
      clearTimeout(timer);
      resolve(result);
    });

    // 将回复通道嵌入负载，渲染进程据此返回结果
    win.webContents.send(channel, { ...payload, _replyChannel: replyChannel });
  });
}

/** 缓存主窗口引用，用于日志转发 */
let _getMainWindow: (() => BrowserWindow | null) | null = null;

/** 向主进程和渲染进程同时输出日志 */
function mcpLog(level: 'log' | 'error', message: string): void {
  console[level](message);
  try {
    _getMainWindow?.()?.webContents.send('mcp:log', { level, message });
  } catch {
    // 窗口可能已关闭，忽略
  }
}

/**
 * 带日志的工具调用包装器
 */
async function withToolLog<T>(
  toolName: string,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  mcpLog('log', `[MCP][${toolName}] ▶ 开始 ${JSON.stringify(paramSummary(params))}`);
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // 提取结果摘要
    const res = result as any;
    const content = res?.content?.[0]?.text;
    let summary = '';
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.error) {
          summary = `error: ${truncate(String(parsed.error))}`;
        } else if (parsed.success !== undefined) {
          summary = `success: ${parsed.success}`;
          if (parsed.linesGenerated) summary += `, lines: ${parsed.linesGenerated}`;
          if (parsed.linesChanged) summary += `, changed: ${parsed.linesChanged}`;
        } else {
          summary = truncate(content, 120);
        }
      } catch {
        summary = truncate(String(content), 120);
      }
    }
    mcpLog('log', `[MCP][${toolName}] ✔ 完成 (${elapsed}s) ${summary}`);
    return result;
  } catch (err: any) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    mcpLog('error', `[MCP][${toolName}] ✘ 失败 (${elapsed}s) ${err?.message ?? String(err)}`);
    throw err;
  }
}

// ─── 工具注册 ─────────────────────────────────────────────

/**
 * 向控制服务注册所有灵机编辑器工具
 * @param server 工具注册表
 * @param getMainWindow 获取主窗口的回调
 */
export function registerTools(
  server: ToolRegistrar,
  getMainWindow: () => BrowserWindow | null,
): void {
  // 缓存窗口引用供日志转发使用
  _getMainWindow = getMainWindow;
  const videoImportService = getVideoImportService();

  // ─── 1. 获取编辑器状态 ─────────────────────────────────
  server.registerTool(
    'lingji_get_editor_state',
    {
      title: '获取编辑器状态',
      description: '查看灵几编辑器当前打开了哪些文件、正在编辑哪个文件。在执行任何脚本操作前，先调用此工具了解编辑器状态。',
    },
    async () => withToolLog('lingji_get_editor_state', {}, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:get-editor-state');
      return jsonResult(result);
    }),
  );

  server.registerTool(
    'lingji_import_video_source',
    {
      title: '导入媒体来源为原稿',
      description: '导入抖音链接、本地视频或本地音频到当前项目，自动转换、转录并同步为 original.md。',
      inputSchema: {
        sourceType: z.enum(['douyin', 'local_video', 'local_audio']).describe('媒体来源类型'),
        url: z.string().optional().describe('抖音分享链接，sourceType=douyin 时必填'),
        filePath: z.string().optional().describe('本地媒体文件路径，sourceType=local_video/local_audio 时必填'),
        projectDir: z.string().describe('目标项目目录'),
        syncToOriginal: z.boolean().optional().describe('是否同步为 original.md，默认 true'),
      },
    },
    async ({ sourceType, url, filePath, projectDir, syncToOriginal }) =>
      withToolLog(
        'lingji_import_video_source',
        { sourceType, url, filePath, projectDir, syncToOriginal },
        async () => {
          try {
            const result = await videoImportService.importVideoSource(
              sourceType === 'douyin'
                ? {
                    sourceType,
                    url: url ?? '',
                    projectDir,
                    syncToOriginal: syncToOriginal ?? true,
                  }
                : {
                    sourceType,
                    filePath: filePath ?? '',
                    projectDir,
                    syncToOriginal: syncToOriginal ?? true,
                  },
            );
            return jsonResult(result);
          } catch (error) {
            return errorResult(
              error instanceof Error ? error.message : '视频导入失败',
            );
          }
        },
      ),
  );

  server.registerTool(
    'lingji_start_video_import',
    {
      title: '启动媒体导入（非阻塞）',
      description:
        '启动抖音链接 / 本地视频 / 本地音频导入，立即返回 importId；用 lingji_get_video_import_status 轮询进度与结果。',
      inputSchema: {
        sourceType: z.enum(['douyin', 'local_video', 'local_audio']).describe('媒体来源类型'),
        url: z.string().optional().describe('抖音分享链接，sourceType=douyin 时必填'),
        filePath: z.string().optional().describe('本地媒体文件路径，sourceType=local_video/local_audio 时必填'),
        projectDir: z.string().describe('目标项目目录'),
        syncToOriginal: z.boolean().optional().describe('是否同步为 original.md，默认 true'),
      },
    },
    async ({ sourceType, url, filePath, projectDir, syncToOriginal }) =>
      withToolLog(
        'lingji_start_video_import',
        { sourceType, url, filePath, projectDir, syncToOriginal },
        async () => {
          try {
            const progress = videoImportService.startImport(
              sourceType === 'douyin'
                ? { sourceType, url: url ?? '', projectDir, syncToOriginal: syncToOriginal ?? true }
                : { sourceType, filePath: filePath ?? '', projectDir, syncToOriginal: syncToOriginal ?? true },
            );
            return jsonResult(progress);
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : '启动导入失败');
          }
        },
      ),
  );

  server.registerTool(
    'lingji_get_video_import_status',
    {
      title: '查询视频导入状态',
      description: '根据 importId 查询视频导入进度、错误信息或最终结果。',
      inputSchema: {
        importId: z.string().describe('视频导入任务 ID'),
      },
    },
    async ({ importId }) =>
      withToolLog('lingji_get_video_import_status', { importId }, async () => {
        const status = videoImportService.getImportStatus(importId);
        if (!status) {
          return errorResult(`未找到导入任务: ${importId}`);
        }
        return jsonResult(status);
      }),
  );

  // ─── 2. 读取脚本内容 ───────────────────────────────────
  server.registerTool(
    'lingji_read_script',
    {
      title: '读取脚本内容',
      description: '读取脚本文件内容。写稿前用 filePath="original.md" 读取原始素材，审稿前读取 script.md 全文用于分析。',
      inputSchema: {
        filePath: z.string().optional().describe('脚本文件路径（可选，默认为当前文件）'),
      },
    },
    async ({ filePath }) => withToolLog('lingji_read_script', { filePath }, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:read-script', { filePath });
      return jsonResult(result);
    }),
  );

  // ─── 3. 生成脚本（AI 高级生成） ───────────────────────
  server.registerTool(
    'lingji_write_script',
    {
      title: '写稿 - 内置AI模板生成',
      description: `使用编辑器内置 AI 根据口播模板和原始素材生成口播稿。需要用户在设置中配置内部 LLM API Key。

推荐的写稿方式：用 lingji_get_project_context 获取模板列表（id + systemPrompt）→ lingji_read_script 读取素材 → 你自己按模板风格写稿 → lingji_update_script 写入编辑器。
本工具仅在用户明确要求"使用内置AI生成"时使用。`,
      inputSchema: {
        templateCode: z.string().describe('口播模板 id，必须来自 lingji_get_project_context 返回的 templates[].id（内置如 news-broadcast / tech-review / knowledge-popular，也可能是用户自定义模板 id）'),
        rawTextFilePath: z.string().describe('原始文本素材的文件路径（支持绝对路径或相对于项目目录的相对路径），工具会自动读取文件内容'),
      },
    },
    async ({ templateCode, rawTextFilePath }) => withToolLog('lingji_write_script', { templateCode, rawTextFilePath }, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }

      // 解析文件路径并读取内容
      let filePath = rawTextFilePath;
      if (!isAbsolute(filePath)) {
        // 相对路径：先获取项目目录再拼接
        const editorState = await ipcRequest<{ projectDir: string | null }>(
          win,
          'mcp:get-editor-state',
        );
        if (!editorState.projectDir) {
          return errorResult('项目目录未设置，无法解析相对路径。请提供绝对路径或先打开项目。');
        }
        filePath = resolve(editorState.projectDir, filePath);
      }

      let rawText: string;
      try {
        rawText = await readFile(filePath, 'utf-8');
      } catch (err: any) {
        return errorResult(`读取文件失败: ${err?.message ?? String(err)}`);
      }

      // 脚本生成可能耗时较长，超时设为 5 分钟
      const result = await ipcRequest(
        win,
        'mcp:generate-script',
        { templateCode, rawText },
        300_000,
      );
      return jsonResult(result);
    }),
  );

  // ─── 4. 更新脚本内容（直接写入） ──────────────────────
  server.registerTool(
    'lingji_update_script',
    {
      title: '写入/更新脚本内容',
      description: '直接写入或修改脚本文件内容。这是写稿和修改的核心工具——写稿时将完整脚本写入 script.md，修改时写入修改后的完整内容。编辑器会即时更新并高亮变更行。',
      inputSchema: {
        filePath: z.string().optional().describe('目标文件路径（可选，默认为当前文件）'),
        content: z.string().describe('要写入的完整脚本内容'),
        description: z.string().optional().describe('本次变更的简要描述（可选）'),
      },
    },
    async ({ filePath, content, description }) => withToolLog('lingji_update_script', { filePath, description }, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:update-script', {
        filePath,
        content,
        description,
      });
      return jsonResult(result);
    }),
  );

  // ─── 5. 提交脚本审阅 ──────────────────────────────────
  server.registerTool(
    'lingji_review_script',
    {
      title: '审稿 - 审阅脚本并标注问题',
      description: `【审稿必须使用此工具】对脚本进行审阅，找出问题并提交批注。编辑器会在对应位置显示批注卡片，用户可一键采纳修改建议。

工作流程：
1. 先调用 lingji_read_script 读取脚本全文
2. 分析内容找出问题
3. 调用本工具提交批注

每个批注推荐使用 quotedText（原文精确子串）定位，配合 suggestion（替换后的完整文本）实现一键采纳。
示例：{ "quotedText": "据统计有100万人", "text": "数据缺少来源", "suggestion": "据央视报道约有100万人", "severity": "warning" }`,
      inputSchema: {
        filePath: z.string().optional().describe('目标文件路径（可选，默认为当前文件）'),
        summary: z.string().optional().describe('审阅总结'),
        score: z.number().optional().describe('评分（0-100）'),
        annotations: z.array(
          z.object({
            quotedText: z.string().optional().describe(
              '【推荐】需要标注的原文精确子串。提供此字段时 line/endLine 可省略，系统会自动定位。必须是脚本中能精确匹配的子串。',
            ),
            line: z.number().optional().describe('起始行号（当 quotedText 未提供时必填）'),
            endLine: z.number().optional().describe('结束行号（可选，默认与起始行相同）'),
            text: z.string().describe('问题描述'),
            suggestion: z.string().optional().describe(
              '修改建议文本——用于替换 quotedText/原文的完整文本。提供后用户可一键采纳替换。不提供则仅为文字批注。',
            ),
            severity: z.enum(['info', 'warning', 'error'])
              .optional()
              .describe('严重程度（默认 info）'),
          }),
        ).describe('批注列表。推荐使用 quotedText 精确定位，也可用 line 行号定位。'),
      },
    },
    async ({ filePath, summary, score, annotations }) => withToolLog('lingji_review_script', { filePath, summary, score, annotationCount: annotations?.length }, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:submit-review', {
        filePath,
        summary,
        score,
        annotations,
      });
      return jsonResult(result);
    }),
  );

  // ─── 6. 列出项目文件 ──────────────────────────────────
  server.registerTool(
    'lingji_list_project_files',
    {
      title: '列出项目文件',
      description: '列出当前脚本项目的文件列表，了解项目中有哪些文件。',
      inputSchema: {
        directory: z.string().optional().describe('子目录路径（可选，默认为项目根目录）'),
      },
    },
    async ({ directory }) => withToolLog('lingji_list_project_files', { directory }, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:list-project-files', { directory });
      return jsonResult(result);
    }),
  );

  // ─── 7. 获取项目上下文 ────────────────────────────────
  server.registerTool(
    'lingji_get_project_context',
    {
      title: '获取项目上下文、口播模板列表与角色设定',
      description: `获取当前项目信息、可用口播模板列表及其完整写作指令（systemPrompt），以及当前选中的口播角色设定。

写稿前先调用此工具了解项目状态、模板风格要求和角色设定。
- templates：口播模板条目数组，每项包含 id / name / description / systemPrompt；内置模板与用户自定义模板合并返回
- selectedTemplate：当前选中的模板 id
- selectedTemplatePrompt：当前选中模板的完整写作规范（systemPrompt）
- selectedRole：当前选中的口播角色（包含角色名称、描述和角色提示词）
- roleInstruction：如果用户选择了特定角色，此字段包含完整的角色指令，写稿时必须遵循

重要：如果 roleInstruction 不为空，写稿时应将角色风格融入模板要求中。`,
    },
    async () => withToolLog('lingji_get_project_context', {}, async () => {
      const win = getMainWindow();
      if (!win) {
        return errorResult('编辑器窗口未就绪');
      }
      const result = await ipcRequest(win, 'mcp:get-project-context');
      return jsonResult(result);
    }),
  );

  // ─── Pipeline 基础设施工具 ─────
  registerPipelineMcpTools(server, getMainWindow, () => app.getPath('userData'));

  // ─── 发布工具（账号查询/校验 + 发布任务） ─────
  registerPublishTools(server, getMainWindow);
}

// ─── 结果构造辅助 ─────────────────────────────────────────

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
