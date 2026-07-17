import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { ToolRegistrar } from '../control/registry';
import { getPipelineService, type TaskHandle } from '.';
import type { PipelineTaskKind } from './types';
import { runTtsHeadless } from './runs/tts-run';
import { runAnalyzeHeadless } from './runs/analyze-run';
import {
  runCoverPromptHeadless,
  runCoverImagesHeadless,
  runCoversHeadless,
} from './runs/cover-run';
import { runExportHeadless } from './runs/export-run';
import { runPublishMetadataHeadless } from './runs/publish-metadata-run';
import {
  runRegenerateCard,
  runRegenerateCardMedia,
  runConvertCard,
  runSculptCard,
} from './runs/card-run';
import { runDirectorPlanHeadless } from './runs/director-run';
import { runDirectorProductionHeadless } from './director-production-run';
import { requireApprovedDirectorPlan } from './director-gate';

const PROJECT_UPDATED_CHANNEL = 'pipeline:project-updated';

export interface GenerationRunCtx {
  projectPath: string;
  userDataPath: string;
  handle: TaskHandle;
  /** 由 config.extraInput 解析出的额外入参（多数 run 忽略） */
  params?: Record<string, unknown>;
}

export interface GenerationToolConfig {
  name: string;
  title: string;
  description: string;
  kind: PipelineTaskKind;
  /** 任务完成后写回的 project 节，用于 UI 刷新信号 */
  sections: string[];
  /** 追加到 inputSchema 的可选入参；解析后作为 ctx.params 传给 run */
  extraInput?: Record<string, z.ZodTypeAny>;
  /** 创建任务前的快速守卫；失败直接向 CLI/MCP 返回稳定错误码。 */
  preflight?: (projectPath: string, params: Record<string, unknown>) => Promise<void>;
  run: (ctx: GenerationRunCtx) => Promise<unknown>;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(message: string, code?: string) {
  const payload: Record<string, unknown> = { error: message };
  if (code) payload.code = code;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** 通知渲染进程某项目的指定节已更新（若该项目正打开则刷新 UI） */
export function emitProjectUpdated(
  getMainWindow: () => BrowserWindow | null,
  projectPath: string,
  sections: string[],
): void {
  try {
    getMainWindow()?.webContents.send(PROJECT_UPDATED_CHANNEL, { projectPath, sections });
  } catch {
    // 渲染窗口可能已关闭
  }
}

/** 注册一个 headless 生成工具：createTask → 后台 run → 发刷新信号 → 返回 taskId */
export function registerGenerationTool(
  server: ToolRegistrar,
  getMainWindow: () => BrowserWindow | null,
  getUserDataPath: () => string,
  config: GenerationToolConfig,
): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: {
        projectPath: z.string().describe('项目目录绝对路径'),
        ...(config.extraInput ?? {}),
      },
    },
    async ({ projectPath, ...rest }) => {
      try {
        await config.preflight?.(projectPath, rest);
        const userDataPath = getUserDataPath();
        const { taskId } = await getPipelineService().createTask(
          config.kind,
          projectPath,
          async (handle) => {
            const result = await config.run({ projectPath, userDataPath, handle, params: rest });
            emitProjectUpdated(getMainWindow, projectPath, config.sections);
            return result;
          },
        );
        return jsonResult({ taskId, kind: config.kind });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return errorResult(e?.message ?? String(err), e?.code);
      }
    },
  );
}

/** 注册全部 headless 生成工具（本计划：音频；后续计划追加） */
export function registerGenerationTools(
  server: ToolRegistrar,
  getMainWindow: () => BrowserWindow | null,
  getUserDataPath: () => string,
): void {
  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_audio',
    title: '生成口播音频(TTS)',
    description:
      '读取项目 script.md，用应用已配置的 MiniMax TTS 生成 podcast-audio.mp3 与 podcast-subtitles.srt，并把 podcast 指针写回 project.json 的 timeline 节（已打开项目会自动刷新）；返回 taskId（fire-and-poll）。',
    kind: 'tts',
    sections: ['timeline'],
    run: (ctx) => runTtsHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_director_plan',
    title: '生成导演方案',
    description:
      '读取字幕并生成可审阅的结构化导演方案草案；只做规划，不生成卡片、封面图或声音资产。返回 taskId。',
    kind: 'analyze_subtitles',
    sections: ['production'],
    extraInput: { globalPrompt: z.string().optional().describe('整片导演补充要求') },
    run: (ctx) => runDirectorPlanHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_director_approve',
    title: '批准导演方案并开始制作',
    description:
      '以乐观版本锁批准当前导演草案，推进到 production-running，并生成画面、封面、声音、字幕高亮和时间线。省略 revision 时批准当前草案版本。返回 taskId。',
    kind: 'generate_cards',
    sections: ['production', 'aiAnalysis', 'timeline'],
    extraInput: { revision: z.number().int().positive().optional().describe('期望批准的草案版本') },
    run: (ctx) => runDirectorProductionHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_analyze_subtitles',
    title: '字幕分析+卡片生成',
    description:
      '读取 podcast-subtitles.srt，做语义分段并批量生成 AI 卡片与封面提示词，写入 project.json 的 aiAnalysis 节；返回 taskId。注意：本应用中卡片随分析一并产出（cards gen 与 subtitle analyze 等价）。',
    kind: 'analyze_subtitles',
    // analyze 现在会顺带生成作品标题（meta/publish 段）
    sections: ['aiAnalysis', 'meta', 'publish'],
    run: (ctx) => runAnalyzeHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_cover_prompts',
    title: '生成封面提示词',
    description:
      '基于字幕与分析结果生成封面提示词，写入 aiAnalysis.analysisResult.coverPrompts；需先完成 subtitle analyze。返回 taskId。',
    kind: 'generate_covers',
    sections: ['aiAnalysis'],
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runCoverPromptHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_cover_images',
    title: '生成封面图',
    description: '由现有封面提示词出封面图，写入 covers/ 与 aiAnalysis.coverCandidates。返回 taskId。',
    kind: 'generate_covers',
    sections: ['aiAnalysis'],
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runCoverImagesHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_covers',
    title: '封面提示词+出图',
    description: '一次性生成封面提示词并出图。返回 taskId。',
    kind: 'generate_covers',
    sections: ['aiAnalysis'],
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runCoversHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_publish_metadata',
    title: '生成作品标题与发布文案',
    description:
      '基于分析结果/字幕生成作品标题+描述+标签，写入 project.json 的 meta 与 publish 节；默认已有标题时跳过（force 强制重新生成）。返回 taskId（fire-and-poll）。',
    kind: 'publish_metadata',
    sections: ['meta', 'publish'],
    extraInput: { force: z.boolean().optional().describe('已有标题时也强制重新生成') },
    run: (ctx) => runPublishMetadataHeadless(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_export_video',
    title: '导出 MP4',
    description: '用 Remotion 渲染时间线为 H.264 MP4，写入项目目录（可用 out 指定文件名/路径）。返回 taskId。',
    kind: 'export_video',
    sections: [],
    extraInput: { out: z.string().optional().describe('输出文件名或绝对路径，默认 export.mp4') },
    run: (ctx) => runExportHeadless(ctx, { out: ctx.params?.out as string | undefined }),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_regenerate_card',
    title: '重新生成卡片',
    description: '按 cardId 重新生成整卡（复用分析卡片生成逻辑）。返回 taskId。',
    kind: 'generate_cards',
    sections: ['aiAnalysis'],
    extraInput: { cardId: z.string().describe('卡片 id') },
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runRegenerateCard(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_regenerate_card_media',
    title: '重新生成卡片媒体',
    description: '仅重新生成 image/video 卡的媒体素材（复用卡片现有 prompt/aspectRatio/provider/model）。返回 taskId。',
    kind: 'generate_cards',
    sections: ['aiAnalysis'],
    extraInput: { cardId: z.string().describe('卡片 id') },
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runRegenerateCardMedia(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_sculpt_card',
    title: '精雕 Motion 卡片',
    description:
      '对现有 motion 卡做多 agent 精雕（导演诊断现有实现→雕刻修改→渲染验证→审查回炉），可用 notes 附加精雕要求；耗时分钟级。返回 taskId（fire-and-poll）。',
    kind: 'sculpt_card',
    sections: ['aiAnalysis'],
    extraInput: {
      cardId: z.string().describe('卡片 id'),
      notes: z.string().optional().describe('精雕要求（可选，如"数字更有冲击力""装饰层太抢戏"）'),
    },
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runSculptCard(ctx),
  });

  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_convert_card',
    title: '转换卡片类型',
    description: '将卡片转换为 image/video（本地重写空 idle media，随后可 regen-media）或 motion（生成+合并）。返回 taskId。',
    kind: 'generate_motion',
    sections: ['aiAnalysis'],
    extraInput: {
      cardId: z.string().describe('卡片 id'),
      to: z.enum(['image', 'video', 'motion']).describe('目标类型'),
    },
    preflight: (projectPath) => requireApprovedDirectorPlan(projectPath).then(() => undefined),
    run: (ctx) => runConvertCard(ctx),
  });
}
