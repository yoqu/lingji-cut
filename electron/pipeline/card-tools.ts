import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { ToolRegistrar } from '../control/registry';
import { listCards, getCard, updateCard, deleteCard, getCardContext, validateCard } from './card-ops';
import { emitProjectUpdated } from './headless-generation';
import type { AICard } from '../../src/types/ai';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(message: string, code?: string) {
  const payload: Record<string, unknown> = { error: message };
  if (code) payload.code = code;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}
function err(e: unknown) {
  const x = e as { code?: string; message?: string };
  return errorResult(x?.message ?? String(e), x?.code);
}

export function registerCardTools(
  server: ToolRegistrar,
  getMainWindow: () => BrowserWindow | null,
  getUserDataPath: () => string,
): void {
  server.registerTool(
    'lingji_list_cards',
    { title: '列出卡片', description: '返回项目 AI 卡片摘要（id/segmentId/type/title/enabled/时间/renderMode）。', inputSchema: { projectPath: z.string() } },
    async ({ projectPath }) => { try { return jsonResult(await listCards(projectPath)); } catch (e) { return err(e); } },
  );
  server.registerTool(
    'lingji_get_card',
    { title: '查看卡片', description: '返回单张卡片完整对象。', inputSchema: { projectPath: z.string(), cardId: z.string() } },
    async ({ projectPath, cardId }) => { try { return jsonResult(await getCard(projectPath, cardId)); } catch (e) { return err(e); } },
  );
  server.registerTool(
    'lingji_update_card',
    {
      title: '修改卡片字段', description: '修改卡片白名单字段（title/enabled/displayMode/start/end/duration/template/stylePresetId/cardPrompt）。',
      inputSchema: {
        projectPath: z.string(), cardId: z.string(),
        title: z.string().optional(), enabled: z.boolean().optional(),
        displayMode: z.enum(['fullscreen', 'pip']).optional(),
        startMs: z.number().optional(), endMs: z.number().optional(), displayDurationMs: z.number().optional(),
        template: z.string().optional(), stylePresetId: z.string().optional(), cardPrompt: z.string().optional(),
      },
    },
    async ({ projectPath, cardId, ...fields }) => {
      try {
        const updated = await updateCard(projectPath, cardId, fields as Partial<AICard>);
        emitProjectUpdated(getMainWindow, projectPath, ['aiAnalysis']);
        return jsonResult(updated);
      } catch (e) { return err(e); }
    },
  );
  server.registerTool(
    'lingji_delete_card',
    { title: '删除卡片', description: '删除卡片并清理其媒体资源。', inputSchema: { projectPath: z.string(), cardId: z.string() } },
    async ({ projectPath, cardId }) => {
      try {
        const r = await deleteCard(projectPath, cardId);
        emitProjectUpdated(getMainWindow, projectPath, ['aiAnalysis']);
        return jsonResult(r);
      } catch (e) { return err(e); }
    },
  );

  server.registerTool(
    'lingji_get_card_context',
    {
      title: '获取卡片上下文',
      description:
        '返回卡片生成/修复所需上下文：项目风格、有效提示词、段落字幕、segment、overlay 与 prompt 绑定。',
      inputSchema: {
        projectPath: z.string(),
        cardId: z.string().optional(),
        segmentId: z.string().optional(),
        visualType: z.enum(['motion', 'image']).optional(),
      },
    },
    async ({ projectPath, cardId, segmentId, visualType }) => {
      try {
        return jsonResult(
          await getCardContext(projectPath, getUserDataPath(), {
            cardId,
            segmentId,
            visualType,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'lingji_validate_card',
    {
      title: '验证卡片',
      description:
        '验证卡片是否可渲染，并检查缺失 overlay、媒体资产、文字对齐与遮挡风险。Motion Card 会先做渲染烟测。',
      inputSchema: { projectPath: z.string(), cardId: z.string() },
    },
    async ({ projectPath, cardId }) => {
      try {
        return jsonResult(await validateCard(projectPath, cardId));
      } catch (e) {
        return err(e);
      }
    },
  );
}
