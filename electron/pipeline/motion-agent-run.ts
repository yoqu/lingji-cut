/**
 * motion-agent-run.ts
 *
 * Motion Card 多 agent 编排器：导演（card-director）→ 雕刻（card-sculptor）→
 * 机械质检（lint + 渲染校验，进程内）→ 审查（card-reviewer）的确定性循环。
 *
 * 这是 Motion TSX 生成的**唯一路径**（无直连 LLM 回退）：ai-analysis 的
 * generateCardForSegment 把提示词素材以闭包交给这里注入的 provider，本文件
 * 用进程内 pi 无头会话（PiHeadlessSession）逐角色执行：
 *   1. 导演：cards.animation 任务书 → JSON 分镜（storyboard）；机器校验
 *      （cue 合法性 / 单调性 / 数字防编造），不合法回喂重出，≤ MAX_STORYBOARD_ITER。
 *   2. 雕刻：cards.segment 任务书（分镜 + motion-kit API + 风格 tokens）+ 逐字稿
 *      → file-first 写 workDir/motionCard.tsx。
 *   3. 机械质检：tsx-lint（禁 API / 非法 import / 循环风险）→ 注入的 validate
 *      （assertCardRenders：编译 + 冒烟渲染 + 布局探针含字幕安全区）；失败回喂雕刻，≤ MAX_FIX_ITER。
 *   4. 审查：内容正确性与设计兑现度分级裁决；只有内容缺失、错锚、焦点缺席、
 *      矛盾终态等硬错误阻断，设计保真偏差只记录 warning。硬错误回喂雕刻，
 *      ≤ MAX_REVIEW_ITER。
 *
 * 循环上限、阶段进度（onPhase）与 abort 全部由本编排器确定性控制，不依赖模型自觉。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MotionCardAgentContext,
  MotionCardAgentProvider,
  MotionCardAgentResult,
} from '../../src/lib/ai-analysis';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import type { AssetResolutionResult, CardAssetBinding } from '../../src/types/assets';
import type { MotionCardMechanicalValidation } from '../../src/types/motion';
import type { PromptKind } from '../../src/lib/prompts/types';
import { resolvePromptBinding } from '../../src/lib/llm/binding-resolver';
import { piModelRef } from '../agent-runtime/pi-provider-projection';
import {
  parseStoryboard,
  storyboardParseHint,
  validateStoryboard,
  formatStoryboardIssues,
} from '../../src/lib/motion-storyboard';
import { lintMotionCardTsx, formatLintIssues } from '../../src/lib/motion-card-lint';
import { buildFallbackCardTsx } from '../../src/lib/motion-card-fallback';
import { compileMotionCardFromStoryboard } from '../../src/lib/motion-card-templates';
import { buildMotionCardProductionReport } from '../../src/lib/motion-production-report';
import { inspectResolvedCardAssets } from '../../src/lib/asset-resolution';
import { motionAssetSignature } from '../../src/lib/motion-asset-layer';
import {
  selectMotionCardKeyframes,
  selectMotionCardProbeFrames,
} from '../../src/lib/motion-keyframes';
import { buildTimingPlan } from '../../src/lib/motion-timing';
import {
  motionCardContactSheetCacheKey,
  renderMotionCardContactSheet,
} from '../remotion/smoke-render';
import {
  PiHeadlessSession,
  ensurePiHeadlessConfig,
  type PiHeadlessCreateInput,
  type PiHeadlessStreamEvent,
} from '../agent-runtime/pi-headless';
import type { AgentFeedEmitInput, AgentFeedRole, AgentFeedStage } from './agent-feed';
import { ensurePiAgentRoles, loadPiAgentRole, type PiAgentRole } from '../agent-runtime/pi-agents-seed';

export const MAX_STORYBOARD_ITER = 2;
/** 解析失败（回复不是合法 JSON）单独计预算，不烧语义回喂轮——弱导演常先输出散文/截断。 */
export const MAX_STORYBOARD_PARSE_RETRY = 2;
export const MAX_FIX_ITER = 3;
export const MAX_REVIEW_ITER = 2;

export interface ReviewVerdictIssue {
  severity?: 'error' | 'warn' | string;
  element?: string;
  rule?: string;
  fix?: string;
  code?: string;
  message?: string;
  frame?: number;
  beat?: number;
  visualProblem?: string;
}

export const BLOCKING_REVIEW_CODES = [
  'content-missing',
  'content-mismatch',
  'cue-mismatch',
  'focus-missing',
  'contradictory-state',
] as const;

const blockingReviewCodes = new Set<string>(BLOCKING_REVIEW_CODES);

function normalizeReviewIssue(issue: ReviewVerdictIssue): ReviewVerdictIssue {
  const code = typeof issue.code === 'string' ? issue.code.trim() : '';
  return {
    ...issue,
    ...(code ? { code } : {}),
    severity: blockingReviewCodes.has(code) ? 'error' : 'warn',
  };
}

export interface ReviewVerdict {
  pass: boolean;
  issues: ReviewVerdictIssue[];
  unavailableReason?: string;
}

function unavailableReviewVerdict(reason: string): ReviewVerdict {
  return {
    pass: false,
    unavailableReason: reason,
    issues: [
      {
        severity: 'warn',
        code: 'review-unavailable',
        message: reason,
        rule: '审查输出',
        fix: '保留机械质检结果，并在后续重生或精雕时重新触发审查。',
      },
    ],
  };
}

/** 容错解析审查 JSON：抽第一个 {...}；解析失败显式降级，不伪装为审查通过。 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return unavailableReviewVerdict('审查员未输出 JSON 裁决，无法形成设计审片结论。');
  try {
    const parsed = JSON.parse(m[0]) as Partial<ReviewVerdict>;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter((issue): issue is ReviewVerdictIssue => Boolean(issue) && typeof issue === 'object')
          .map(normalizeReviewIssue)
      : [];
    const hasBlockingIssue = issues.some((issue) => issue?.severity === 'error');
    return {
      pass: !hasBlockingIssue,
      issues,
    };
  } catch {
    return unavailableReviewVerdict('审查员 JSON 裁决解析失败，无法形成设计审片结论。');
  }
}

/** 工具入参序列化（观测展示用，容错非 JSON / 循环引用）。 */
function safeStringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validationIssuesFromError(error: unknown): MotionCardMechanicalValidation['issues'] | null {
  if (!error || typeof error !== 'object' || !('validation' in error)) return null;
  const validation = (error as { validation?: Partial<MotionCardMechanicalValidation> }).validation;
  return Array.isArray(validation?.issues) ? validation.issues : null;
}

function imageMime(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/png';
}

async function prepareContactSheetAssets(
  bindings: CardAssetBinding[],
  projectPath: string,
): Promise<{ bindings: CardAssetBinding[]; issues: Array<{ severity: 'warning'; code: string; message: string }> }> {
  const issues: Array<{ severity: 'warning'; code: string; message: string }> = [];
  const prepared = await Promise.all(bindings.map(async (binding) => {
    if (/^(data:|https?:)/i.test(binding.filePath)) return binding;
    const filePath = path.isAbsolute(binding.filePath)
      ? binding.filePath
      : path.resolve(projectPath, binding.filePath);
    try {
      const bytes = await fs.readFile(filePath);
      return {
        ...binding,
        filePath: `data:${imageMime(filePath)};base64,${bytes.toString('base64')}`,
      };
    } catch {
      issues.push({
        severity: 'warning',
        code: 'asset-preview-unavailable',
        message: `资产“${binding.request?.query ?? binding.slot}”无法读取，关键帧审片不会显示该资产。`,
      });
      return null;
    }
  }));
  return { bindings: prepared.filter((item): item is CardAssetBinding => item != null), issues };
}

function formatIssues(issues: ReviewVerdict['issues']): string {
  return issues
    .map(
      (it, i) => {
        const where = [
          typeof it.frame === 'number' ? `frame ${it.frame}` : '',
          typeof it.beat === 'number' ? `beat ${it.beat}` : '',
          it.element ?? '',
        ]
          .filter(Boolean)
          .join(' / ');
        const detail = it.visualProblem ?? it.message ?? it.fix ?? '';
        return `${i + 1}. [${it.severity ?? 'warn'}] ${where} 违反「${it.rule ?? ''}」：${detail}`;
      },
    )
    .join('\n');
}

export interface MotionAgentProviderOptions {
  userDataPath: string;
  projectPath: string;
  /** 角色种子目录（resources/pi-agents/agents）；由调用方按 app.getAppPath() 解析。 */
  rolesSeedDir: string;
  signal?: AbortSignal;
  /**
   * 会话级模型覆盖（`${providerId}/${modelId}`）：导演跟随 cards.animation 绑定、
   * 雕刻/审查跟随 cards.segment 绑定；缺省则跟随 pi settings 默认。
   * 由 resolveMotionCardModels 从提示词绑定解析。
   */
  directorModel?: string;
  sculptorModel?: string;
  /** 阶段回调（导演/雕刻/验证/审查/修复），供任务进度映射。 */
  onPhase?: (phase: string) => void;
  /** 观测事件回调（角色流式输出/工具调用/编排里程碑），供渲染端观测面板。 */
  onAgentEvent?: (ev: AgentFeedEmitInput) => void;
  /** 可选：生成关键帧 contact sheet PNG 的缓存目录；不传则只记录关键帧索引。 */
  contactSheetCacheDir?: string;
  /** 测试注入。 */
  deps?: {
    createSession?: (input: PiHeadlessCreateInput) => Promise<Pick<PiHeadlessSession, 'prompt' | 'dispose' | 'abort'>>;
    loadRole?: (name: Parameters<typeof loadPiAgentRole>[0]) => Promise<PiAgentRole>;
    ensureConfig?: () => Promise<unknown>;
    ensureRoles?: () => Promise<void>;
  };
}

/**
 * 创建 Motion Card 多 agent provider（注入 generateCardForSegment.options.generateMotionCard）。
 * 每次调用（即每张 motion 卡）在独立临时 workDir 内完成，互不干扰，可并发。
 */
export function createMotionCardAgentProvider(opts: MotionAgentProviderOptions): MotionCardAgentProvider {
  const {
    userDataPath,
    rolesSeedDir,
    signal,
    directorModel,
    sculptorModel,
    onPhase,
    onAgentEvent,
    contactSheetCacheDir,
    deps = {},
  } = opts;
  const createSession = deps.createSession ?? PiHeadlessSession.create.bind(PiHeadlessSession);
  const loadRole =
    deps.loadRole ?? ((name: Parameters<typeof loadPiAgentRole>[0]) => loadPiAgentRole(name, { seedRoot: rolesSeedDir }));
  const ensureConfig = deps.ensureConfig ?? (() => ensurePiHeadlessConfig(userDataPath));
  const ensureRoles = deps.ensureRoles ?? (() => ensurePiAgentRoles(rolesSeedDir));

  return async (ctx: MotionCardAgentContext): Promise<MotionCardAgentResult> => {
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('Motion 卡多 agent 生成已取消');
    };
    throwIfAborted();
    await ensureConfig();
    await ensureRoles();

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-motion-'));
    const tsxPath = path.join(workDir, 'motionCard.tsx');
    if (ctx.existingTsx) {
      await fs.writeFile(tsxPath, ctx.existingTsx, 'utf-8');
    }

    const label = ctx.label ?? ctx.segmentId;

    // ── 观测事件：按卡片键（segmentId）标注，供渲染端观测面板还原对话流。
    const feedEmit = onAgentEvent
      ? (ev: Omit<AgentFeedEmitInput, 'cardKey' | 'cardLabel'>) =>
          onAgentEvent({ ...ev, cardKey: ctx.segmentId, cardLabel: label })
      : undefined;
    const milestone = (text: string) => feedEmit?.({ role: 'orchestrator', kind: 'milestone', text });
    const roleStream = (role: AgentFeedRole, model?: string): Pick<PiHeadlessCreateInput, 'onEvent'> =>
      feedEmit
        ? {
            onEvent: (ev: PiHeadlessStreamEvent) => {
              if (ev.type === 'text_delta') feedEmit({ role, kind: 'text', text: ev.delta, model });
              else if (ev.type === 'thinking_delta') feedEmit({ role, kind: 'thinking', text: ev.delta, model });
              else if (ev.type === 'tool_use') {
                feedEmit({
                  role,
                  kind: 'tool_use',
                  toolCallId: ev.id,
                  toolName: ev.name,
                  toolInput: safeStringify(ev.input),
                  model,
                });
              } else {
                feedEmit({
                  role,
                  kind: 'tool_result',
                  toolCallId: ev.toolUseId,
                  toolName: ev.name,
                  toolOutput: ev.content,
                  isError: ev.isError,
                  model,
                });
              }
            },
          }
        : {};

    let phaseStartedAt = Date.now();
    const setPhase = (phase: string, stage?: AgentFeedStage, round?: number) => {
      phaseStartedAt = Date.now();
      onPhase?.(phase);
      feedEmit?.({ role: 'orchestrator', kind: 'phase', text: phase, stage, round });
    };
    const emit = (phase: string, ok = true, extra: Record<string, unknown> = {}) => {
      ctx.telemetry?.emit('llm.end', {
        label: `${label}:${phase}`,
        attempt: 0,
        durationMs: Date.now() - phaseStartedAt,
        ok,
        ...extra,
      });
    };
    // 传输层容错：provider 截断 / 网络抖动（如 "Unexpected end of JSON input"）重试一次，
    // 不让单次瞬时故障直接判死整张卡。
    const promptWithRetry = async (
      session: Pick<PiHeadlessSession, 'prompt'>,
      text: string,
    ): Promise<string> => {
      try {
        return await session.prompt(text);
      } catch (err) {
        throwIfAborted();
        emit('prompt-retry', false, { error: err instanceof Error ? err.message : String(err) });
        return await session.prompt(text);
      }
    };

    let sculptor: Awaited<ReturnType<typeof createSession>> | null = null;
    try {
      // ── 1. 导演：JSON 分镜 + 机器校验回喂 ─────────────────────────────────────
      let direction = '';
      const storyboardDraft = parseStoryboard(ctx.animationDirectionDraft ?? '');
      const storyboardDraftVerdict = validateStoryboard(storyboardDraft, {
        cueCount: ctx.cueCount ?? 0,
        transcript: ctx.segmentTranscript,
        requireCapacityModel: true,
      });
      if (ctx.reuseStoryboardDraft && storyboardDraft && storyboardDraftVerdict.ok) {
        setPhase('复用分镜', 'director');
        direction = JSON.stringify(storyboardDraft, null, 2);
        milestone('已按当前合法 storyboard 跳过导演，直接进入雕刻');
        emit('director', true, { reusedStoryboard: true });
      } else {
        setPhase('导演', 'director');
        const directorRole = await loadRole('card-director');
        const director = await createSession({
          systemPrompt: directorRole.systemPrompt,
          tools: [],
          cwd: workDir,
          signal,
          model: directorModel,
          ...roleStream('director', directorModel),
        });
        try {
        const parts = [ctx.buildDirectorPrompt()];
        if (ctx.animationDirectionDraft) {
          parts.push(`===== 用户已有的动画指导草案（保留其载体与节拍意图，补全为合法 storyboard）=====\n${ctx.animationDirectionDraft}`);
        }
        if (ctx.existingTsx) {
          parts.push(
            `===== 现有组件源码（精雕模式：先诊断其设计问题——载体选错 / 状态演进缺失 / 焦点不明 / 节拍脱节，分镜须针对性修正）=====\n\`\`\`tsx\n${ctx.existingTsx}\n\`\`\``,
          );
        }
        const FIELD_EXAMPLE = `{"claim":"...","carrier":"data-hero","layout":"title-hero","scene":"...","data":{"value":28842,"unit":"人","label":"考研报名"},"elements":[{"id":"title","role":"support","slot":"header","content":"考研报名","heightRatio":0.12},{"id":"hero","role":"focus","slot":"main","content":"28842人","heightRatio":0.42}],"capacity":{"maxVisible":2,"maxHeightRatio":0.62},"focus":{"beat":1,"emphasis":"countup-settle"},"beats":[{"cue":null,"kind":"build","adds":"标题「考研报名」","motion":"软落入场","lifecycle":{"enter":["title"]}},{"cue":2,"kind":"build","adds":"数字 28842","changes":"标题收为辅助，数字成为焦点","motion":"计数到 28842","lifecycle":{"enter":["hero"],"collapse":["title"]}}]}`;
        let reply = (await promptWithRetry(director, parts.join('\n\n'))).trim();
        // 解析失败与语义失败分开计预算：解析重试只需"重新输出 JSON"，
        // 不该消耗针对 cue/数字等设计错误的语义回喂轮（弱导演常先散文/截断再给对 JSON）。
        let parseRounds = 0;
        let semanticRounds = 0;
        for (;;) {
          throwIfAborted();
          const storyboard = parseStoryboard(reply);
          const verdictSb = validateStoryboard(storyboard, {
            cueCount: ctx.cueCount ?? 0,
            transcript: ctx.segmentTranscript,
            requireCapacityModel: true,
          });
          if (verdictSb.ok && storyboard) {
            direction = JSON.stringify(storyboard, null, 2);
            break;
          }
          const parseFailed = !storyboard;
          const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
          emit('storyboard', false, {
            errors: verdictSb.errors.length,
            detail: verdictSb.errors.slice(0, 3).join('；'),
            ...(parseFailed
              ? { rawHead: oneLine(reply.slice(0, 160)), rawTail: oneLine(reply.slice(-120)) }
              : {}),
          });
          if (parseFailed) {
            milestone(`分镜回复无法解析（第 ${parseRounds + 1} 次）：${storyboardParseHint(reply)}`);
            if (parseRounds >= MAX_STORYBOARD_PARSE_RETRY) {
              throw new Error(
                `导演回复 ${parseRounds + 1} 次均无法解析出 JSON 分镜（${storyboardParseHint(reply)}）；建议更换 cards.animation 绑定的导演模型或关闭其思考输出。`,
              );
            }
            parseRounds += 1;
            setPhase(`分镜重出（解析失败 ${parseRounds}/${MAX_STORYBOARD_PARSE_RETRY}）`, 'director', parseRounds);
            reply = (
              await promptWithRetry(
                director,
                [
                  `===== 上一条回复无法解析出 JSON 分镜 =====`,
                  storyboardParseHint(reply),
                  `重新输出：只输出一个 JSON 对象，不要任何解释 / 思考过程 / markdown 围栏，字段名与示例一致：`,
                  FIELD_EXAMPLE,
                ].join('\n'),
              )
            ).trim();
            continue;
          }
          milestone(
            `分镜未通过机器校验（第 ${semanticRounds + 1} 轮）：${verdictSb.errors.slice(0, 3).join('；')}`,
          );
          if (semanticRounds >= MAX_STORYBOARD_ITER) {
            throw new Error(
              `导演分镜 ${MAX_STORYBOARD_ITER} 轮后仍未通过机器校验：${verdictSb.errors.join('；')}`,
            );
          }
          semanticRounds += 1;
          setPhase(`分镜重出 ${semanticRounds}/${MAX_STORYBOARD_ITER}`, 'director', semanticRounds);
          reply = (
            await promptWithRetry(
              director,
              [
                `===== 分镜未通过机器校验，请逐条修正后重新输出完整 JSON（只输出 JSON，字段名必须与示例一致）=====`,
                formatStoryboardIssues(verdictSb),
                `字段名对照示例（beats 每拍必须有字符串字段 adds；示例仅示范结构，内容用你自己的设计）：`,
                FIELD_EXAMPLE,
              ].join('\n'),
            )
          ).trim();
        }
      } finally {
        director.dispose();
      }
        emit('director');
      }
      throwIfAborted();

      const storyboardForAssets = parseStoryboard(direction);
      let resolvedAssetBindings: CardAssetBinding[] = [];
      let assetResolution: AssetResolutionResult = { bindings: [], generationRequests: [], unresolved: [] };
      if (storyboardForAssets?.assets?.length && ctx.resolveAssets) {
        setPhase('资产生成', 'director');
        milestone(`检测到 ${storyboardForAssets.assets.length} 个资产需求，开始匹配素材库并自动生成缺失资产`);
        try {
          const startedAt = Date.now();
          ctx.telemetry?.emit('asset.resolve.start', {
            segmentId: ctx.segmentId,
            requested: storyboardForAssets.assets.length,
          });
          const assetResult = await ctx.resolveAssets({
            requests: storyboardForAssets.assets,
            sourceCardId: ctx.sourceCardId ?? `${ctx.segmentId}-card-1`,
            signal,
          });
          assetResolution = assetResult;
          resolvedAssetBindings = assetResult.bindings;
          ctx.telemetry?.emit('asset.resolve.end', {
            segmentId: ctx.segmentId,
            durationMs: Date.now() - startedAt,
            ok: true,
            requested: storyboardForAssets.assets.length,
            matched: assetResult.bindings.length,
            pending: assetResult.generationRequests.length,
            unresolved: assetResult.unresolved.length,
            ...(assetResult.activity ?? {}),
          });
          emit('assets', true, {
            bindings: assetResult.bindings.length,
            pending: assetResult.generationRequests.length,
            unresolved: assetResult.unresolved.length,
          });
          milestone(
            `资产解析完成：可用 ${assetResult.bindings.length} 个，待生成/失败 ${assetResult.generationRequests.length} 个，未解析 ${assetResult.unresolved.length} 个`,
          );
        } catch (err) {
          ctx.telemetry?.emit('asset.resolve.end', {
            segmentId: ctx.segmentId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          if (signal?.aborted) throw err;
          assetResolution = {
            bindings: [],
            generationRequests: [],
            unresolved: storyboardForAssets.assets,
          };
          emit('assets', false, { error: err instanceof Error ? err.message : String(err) });
          milestone(`资产解析/生成失败，继续生成无资产 Motion Card：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const storyboard = storyboardForAssets ?? parseStoryboard(direction);
      const durationInFrames = ctx.timingInput
        ? Math.max(1, Math.round((ctx.timingInput.durationMs / 1000) * ctx.timingInput.fps))
        : 150;
      const timingPlan = ctx.timingInput
        ? buildTimingPlan({
            ...ctx.timingInput,
            storyboard,
          })
        : undefined;
      const framesChecked = selectMotionCardKeyframes({
        storyboard,
        durationInFrames,
        cues: timingPlan?.cues,
      });
      const probeFrames = selectMotionCardProbeFrames({
        storyboard,
        durationInFrames,
        cues: timingPlan?.cues,
        timingPlan,
      });
      const validationInput = {
        cues: timingPlan?.cues ?? [],
        timingPlan,
        frames: probeFrames,
        durationInFrames,
        assetBindings: resolvedAssetBindings,
        checkRenderedLayout: true,
      };

      // ── 2. 出卡路径分支 ─────────────────────────────────────────────────────────
      // template（默认）：storyboard 确定性编译 → 机械质检一次，不经 LLM 雕刻/审查；
      // agent：LLM 雕刻 → 修复循环 → 审查（精雕 existingTsx 或显式 agent 模式）。
      const templateMode = (ctx.motionCardMode ?? 'template') === 'template' && !ctx.existingTsx;

      // 两条路径共享的状态。
      const readTsx = async (): Promise<string> => {
        try {
          return (await fs.readFile(tsxPath, 'utf-8')).trim();
        } catch {
          return '';
        }
      };

      let tsx = '';
      let fixIter = 0;
      let reviewIter = 0;
      let rescueTried = false;
      let fallbackUsed = false;
      let compiledTemplate = false;
      let latestLintIssues: ReturnType<typeof lintMotionCardTsx>['issues'] = [];
      let latestLayoutIssues: Array<{
        severity: 'error' | 'warning';
        code: string;
        message: string;
        frame?: number;
        element?: string;
      }> = [];
      let finalReviewIssues: ReviewVerdict['issues'] = [];

      // 终极兜底：LLM 雕刻或模板编译彻底失败时，由分镜确定性编译一张纯原语简版卡（不经 LLM）。
      const tryDeterministicFallback = async (lastProblem: string): Promise<boolean> => {
        try {
          const storyboard = parseStoryboard(direction);
          if (!storyboard) return false;
          const fallbackTsx = buildFallbackCardTsx(storyboard, ctx.presetMotionTokens ?? '{}');
          const lint = lintMotionCardTsx(fallbackTsx, { requireSafeLayout: ctx.qualityMode !== 'director' });
          if (!lint.ok) {
            emit('fallback', false, { error: formatLintIssues(lint.issues).slice(0, 200) });
            return false;
          }
          const validation = await ctx.validate?.(fallbackTsx, validationInput);
          latestLayoutIssues = validation?.issues ?? [];
          await fs.writeFile(tsxPath, fallbackTsx, 'utf-8');
          tsx = fallbackTsx;
          fallbackUsed = true;
          emit('fallback', true, { reason: lastProblem.slice(0, 160) });
          milestone('LLM 雕刻未能通过校验，已由分镜确定性编译兜底卡');
          return true;
        } catch (err) {
          emit('fallback', false, { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          return false;
        }
      };

      let contactSheetCacheKey: string | undefined;
      let contactSheetPath: string | undefined;
      let contactSheetCached: boolean | undefined;
      let contactSheetError: string | undefined;
      let preparedContactSheetKey: string | undefined;
      let reviewUnavailableReason: string | undefined;
      const contactSheetAssets = await prepareContactSheetAssets(resolvedAssetBindings, opts.projectPath);
      const assetIssues = [
        ...inspectResolvedCardAssets(assetResolution),
        ...contactSheetAssets.issues,
      ];

      const updateContactSheet = async (): Promise<void> => {
        const nextKey = contactSheetCacheDir
          ? motionCardContactSheetCacheKey({
              tsx,
              frames: framesChecked,
              storyboard: direction,
              assetSignature: motionAssetSignature(contactSheetAssets.bindings),
            })
          : undefined;
        if (preparedContactSheetKey === nextKey) return;
        preparedContactSheetKey = nextKey;
        contactSheetCacheKey = nextKey;
        contactSheetPath = undefined;
        contactSheetCached = undefined;
        contactSheetError = undefined;
        if (!contactSheetCacheDir || !nextKey) return;
        try {
          const sheet = await renderMotionCardContactSheet(tsx, {
            frames: framesChecked,
            cacheDir: contactSheetCacheDir,
            cacheKey: nextKey,
            cues: timingPlan?.cues,
            timingPlan,
            durationInFrames,
            assetBindings: contactSheetAssets.bindings,
          });
          contactSheetPath = sheet.cachePath;
          contactSheetCached = sheet.cached;
        } catch (err) {
          contactSheetError = err instanceof Error ? err.message : String(err);
          milestone(`关键帧 contact sheet 生成失败：${contactSheetError}`);
        }
      };

      const visualReviewUnavailableReason = (): string => {
        if (contactSheetError) return `关键帧 contact sheet 生成失败：${contactSheetError}`;
        if (contactSheetPath) {
          return '关键帧 contact sheet 已生成，但当前 pi headless 审查会话未提供可靠的图片多模态输入；本轮按 storyboard + TSX 文本审查降级。';
        }
        return '未配置关键帧 contact sheet 缓存目录；本轮按 storyboard + TSX 文本审查降级。';
      };

      const finish = async (): Promise<MotionCardAgentResult> => {
        feedEmit?.({
          role: 'orchestrator',
          kind: 'done',
          text: fallbackUsed ? '完成（兜底出卡）' : compiledTemplate ? '完成（模板编译）' : '生成完成',
        });
        await updateContactSheet();
        return {
          tsx,
          animationDirection: direction,
          assetBindings: resolvedAssetBindings,
          productionReport: buildMotionCardProductionReport({
            fallbackUsed,
            compiled: compiledTemplate,
            fixRounds: fixIter,
            reviewRounds: reviewIter,
            framesChecked,
            lintIssues: latestLintIssues,
            layoutIssues: latestLayoutIssues,
            reviewIssues: finalReviewIssues,
            assetIssues,
            renderOk: true,
            visualReviewAvailable: false,
            unavailableReason:
              reviewUnavailableReason ??
              (compiledTemplate && !fallbackUsed
                ? '模板编译路径：设计约束由分镜机器校验与模板确定性保证，未做 LLM 审查。'
                : visualReviewUnavailableReason()),
            contactSheetPath,
            contactSheetCacheKey,
            contactSheetCached,
            contactSheetError,
          }),
        };
      };

      if (templateMode) {
        // ── 模板编译主路径：storyboard → 确定性 TSX，不创建雕刻/审查会话 ──
        setPhase('模板编译', 'sculpt');
        const compileStartedAt = Date.now();
        ctx.telemetry?.emit('card.compile.start', { segmentId: ctx.segmentId, carrier: storyboard?.carrier });
        let compileProblem: string | null = null;
        if (!storyboard) {
          compileProblem = '分镜解析失败，无法模板编译';
        } else {
          try {
            tsx = compileMotionCardFromStoryboard(storyboard, ctx.presetMotionTokens ?? '{}');
            const lint = lintMotionCardTsx(tsx, { requireSafeLayout: ctx.qualityMode !== 'director' });
            latestLintIssues = lint.issues;
            if (!lint.ok) {
              compileProblem = `模板产物静态 lint 未通过：\n${formatLintIssues(lint.issues.filter((i) => i.severity === 'error'))}`;
            } else {
              setPhase('验证', 'mechqa');
              try {
                const validation = await ctx.validate?.(tsx, validationInput);
                latestLayoutIssues = validation?.issues ?? [];
                const layoutErrors = latestLayoutIssues.filter((issue) => issue.severity === 'error');
                if (layoutErrors.length > 0) {
                  compileProblem = `布局探针未通过：\n${layoutErrors.map((issue) => `[${issue.code}] ${issue.message}`).join('\n')}`;
                }
              } catch (err) {
                const validationIssues = validationIssuesFromError(err);
                if (validationIssues) latestLayoutIssues = validationIssues;
                compileProblem = `渲染校验失败：${err instanceof Error ? err.message : String(err)}`;
              }
            }
          } catch (err) {
            compileProblem = `模板编译异常：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (compileProblem) {
          ctx.telemetry?.emit('card.compile.end', {
            segmentId: ctx.segmentId,
            carrier: storyboard?.carrier,
            durationMs: Date.now() - compileStartedAt,
            ok: false,
            error: compileProblem.slice(0, 300),
          });
          milestone(`模板编译未通过（${storyboard?.carrier ?? 'unknown'}），切换确定性兜底`);
          setPhase('兜底出卡', 'sculpt');
          if (!(await tryDeterministicFallback(compileProblem))) {
            throw new Error(`Motion 卡模板编译失败且确定性兜底未通过校验：${compileProblem}`);
          }
        } else {
          compiledTemplate = true;
          ctx.telemetry?.emit('card.compile.end', {
            segmentId: ctx.segmentId,
            carrier: storyboard?.carrier,
            durationMs: Date.now() - compileStartedAt,
            ok: true,
          });
          milestone(`已由分镜确定性编译（${storyboard?.carrier}），跳过雕刻与审查`);
        }
        return await finish();
      }

      // ── agent 路径：雕刻 → 机械质检修复 → 审查 ──────────────────────────────────
      setPhase('雕刻', 'sculpt');
      const sculptorRole = await loadRole('card-sculptor');
      sculptor = await createSession({
        systemPrompt: sculptorRole.systemPrompt,
        tools: ['read', 'write', 'edit'],
        cwd: workDir,
        writeWithinDir: workDir,
        signal,
        model: sculptorModel,
        ...roleStream('sculptor', sculptorModel),
      });
      const sculptParts = [
        ctx.buildCardPrompt(direction, resolvedAssetBindings),
        `===== 本段口播逐字稿（内容忠实的唯一来源）=====\n${ctx.segmentTranscript}`,
        ctx.existingTsx
          ? `===== 执行 =====\n工作目录已有 motionCard.tsx（现有实现）。按任务书与分镜用 edit 工具针对性改造它；改造完成即停止。`
          : `===== 执行 =====\n用 write 工具把完整组件写入 ./motionCard.tsx；写完即停止。`,
      ];
      await promptWithRetry(sculptor, sculptParts.join('\n\n'));

      // ── 3/4. 验证 + 审查循环（agent 路径）──────────────────────────────────────
      // 单轮"取件+机械质检"：lint error / 结构缺失 / validate 抛错时回喂雕刻修复；耗尽即失败。
      const validateWithFixes = async (): Promise<void> => {
        for (;;) {
          throwIfAborted();
          tsx = await readTsx();
          let problem: string | null = null;
          if (!tsx || !tsx.includes('export default')) {
            problem = 'motionCard.tsx 缺失或没有 export default 的组件；请用 write 工具写入完整组件。';
          } else {
            setPhase('验证', 'mechqa');
            const lint = lintMotionCardTsx(tsx, { requireSafeLayout: ctx.qualityMode !== 'director' });
            latestLintIssues = lint.issues;
            if (!lint.ok) {
              problem = `静态 lint 未通过：\n${formatLintIssues(lint.issues.filter((i) => i.severity === 'error'))}`;
            } else {
              try {
                const validation = await ctx.validate?.(tsx, validationInput);
                latestLayoutIssues = validation?.issues ?? [];
                const layoutErrors = latestLayoutIssues.filter((issue) => issue.severity === 'error');
                if (layoutErrors.length > 0) {
                  problem = `布局探针未通过：\n${layoutErrors.map((issue) => `[${issue.code}] ${issue.message}`).join('\n')}`;
                }
              } catch (err) {
                const validationIssues = validationIssuesFromError(err);
                if (validationIssues) latestLayoutIssues = validationIssues;
                problem = `渲染校验失败：${err instanceof Error ? err.message : String(err)}`;
              }
            }
          }
          if (!problem) return;
          emit('validate', false, { error: problem });
          milestone(`机械质检未通过：${problem}`);
          if (fixIter >= MAX_FIX_ITER) {
            // 降级救援（一次性）：多轮逐点修复仍卡在布局，说明自由布局能力不足——
            // 推倒重写为纯原语组合（原语内置安全区/配重/排布，结构上不会横竖溢出）。
            if (!rescueTried) {
              rescueTried = true;
              setPhase('简化重写', 'sculpt');
              await promptWithRetry(
                sculptor!,
                [
                  `===== 多轮修复仍未通过校验，执行降级重写 =====`,
                  `剩余问题：\n${problem}`,
                  `放弃现有自定义布局，用 write 整体重写 motionCard.tsx，规则收紧为：`,
                  `- 只用 <CardStage tokens={TOKENS}> 作根 + useBeats 定节拍 + 内容原语（Kicker/StatHero/BarChart/TrendLine/CompareRow/ListBuild/ProcessFlow/QuoteBlock）自上而下纵向排布（外层再包一个 display:'flex', flexDirection:'column', gap 适度的 div 即可）。`,
                  `- 不写任何 position:'absolute'；不写固定像素宽高（原语自适应）；每行上屏文字 ≤ 14 字。`,
                  `- 分镜的每一拍映射到一个原语；内容装不下就删次要拍，保住 focus 焦点拍。`,
                ].join('\n'),
              );
              continue;
            }
            setPhase('兜底出卡', 'sculpt');
            if (await tryDeterministicFallback(problem)) return;
            throw new Error(`Motion 卡多 agent 生成失败（修复 ${MAX_FIX_ITER} 轮 + 降级重写后仍未通过渲染校验）：${problem}`);
          }
          fixIter += 1;
          setPhase(`修复 ${fixIter}/${MAX_FIX_ITER}`, 'mechqa', fixIter);
          await promptWithRetry(
            sculptor!,
            `===== 验证未通过，请修复 =====\n${problem}\n\n逐条定位到 motionCard.tsx 的对应位置用 edit 修复；不要整文件盲目重写，修完自查相邻问题。布局类问题（越界 / 裁切 / 侵入字幕区）优先靠**删减文字、缩短文案、缩小次要元素**解决——内容装不下就删，绝不往字幕安全区（底部 20%）挤；横向排布用 flex + 百分比宽（如两栏各 45%），严禁固定像素宽度相加超过画布。`,
          );
        }
      };

      await validateWithFixes();

      const buildVisualEvidencePrompt = async (): Promise<string> => {
        await updateContactSheet();
        return [
          `===== 关键帧审片材料（contact sheet）=====`,
          `关键帧 frame index：${framesChecked.join(', ') || '无'}`,
          contactSheetPath
            ? `contact sheet PNG：${contactSheetPath}${contactSheetCached ? '（缓存命中）' : '（本轮生成）'}`
            : `contact sheet PNG：不可用（${visualReviewUnavailableReason()}）`,
          `重要：如果当前运行时不能实际读取本地图像，不要声称已完成视觉审片；仍可基于 storyboard、关键帧索引与 TSX 做文本设计审查，并把不可见的画面风险写成 warn。`,
        ].join('\n');
      };

      const reviewerRole = await loadRole('card-reviewer');
      for (;;) {
        // 兜底卡是确定性模板产物，设计审查没有可改空间，直接收尾。
        if (fallbackUsed) break;
        throwIfAborted();
        setPhase('审查', 'review');
        const visualEvidencePrompt = await buildVisualEvidencePrompt();
        const reviewer = await createSession({
          systemPrompt: reviewerRole.systemPrompt,
          tools: [],
          cwd: workDir,
          signal,
          model: sculptorModel,
          ...roleStream('reviewer', sculptorModel),
        });
        let verdict: ReviewVerdict;
        try {
          verdict = parseReviewVerdict(
            await promptWithRetry(reviewer, 
              [
                `===== 导演的 JSON 分镜（storyboard，设计蓝图）=====\n${direction}`,
                ctx.motionBible ? ctx.motionBible : `Motion Bible：无（按单卡分镜独立审查）。`,
                ctx.reviewStyleBlock
                  ? `===== 风格生产细则（偏差记 style-fidelity warn）=====\n${ctx.reviewStyleBlock}`
                  : `风格生产细则：无。`,
                ctx.reviewContentTypeBlock
                  ? `===== 内容类型生产规则（偏差记 carrier-fidelity/style-fidelity warn）=====\n${ctx.reviewContentTypeBlock}`
                  : `内容类型生产规则：无。`,
                `===== 机械校验结论 =====\n已通过（静态 lint + 编译 + 冒烟渲染 + 布局探针含字幕安全区）；机械规则不必复查，只判设计兑现度。`,
                visualEvidencePrompt,
                `===== motionCard.tsx =====\n\`\`\`tsx\n${tsx}\n\`\`\``,
              ].join('\n\n'),
            ),
          );
        } finally {
          reviewer.dispose();
        }
        finalReviewIssues = verdict.issues;
        if (verdict.unavailableReason) {
          reviewUnavailableReason = verdict.unavailableReason;
          emit('review', false, { unavailable: true, error: verdict.unavailableReason });
          milestone(`审查不可用：${verdict.unavailableReason}`);
          break;
        }
        if (verdict.pass) {
          emit('review');
          milestone('审查通过');
          break;
        }
        if (reviewIter >= MAX_REVIEW_ITER) {
          emit('review', false, { unresolved: verdict.issues.length, qualityMode: ctx.qualityMode ?? 'auto' });
          if ((ctx.qualityMode ?? 'auto') === 'auto') {
            setPhase('质量降级', 'sculpt', reviewIter);
            const problem = `审查 ${MAX_REVIEW_ITER} 轮后仍有 ${verdict.issues.length} 项阻断问题：${formatIssues(verdict.issues)}`;
            if (await tryDeterministicFallback(problem)) {
              milestone('审查问题未能消除，自动模式已切换为安全布局兜底卡');
              break;
            }
          }
          throw new Error(
            `Motion Card 质量门禁阻断：审查 ${MAX_REVIEW_ITER} 轮后仍未通过。${formatIssues(verdict.issues)}`,
          );
        }
        milestone(`审查未通过（${verdict.issues.length} 项）：\n${formatIssues(verdict.issues)}`);
        reviewIter += 1;
        setPhase(`回炉 ${reviewIter}/${MAX_REVIEW_ITER}`, 'sculpt', reviewIter);
        await promptWithRetry(
          sculptor,
          `===== 审查未通过（第 ${reviewIter} 轮），请按意见修复 =====\n${formatIssues(verdict.issues)}\n\n逐条修复后自查相邻铁律；只改相关代码。`,
        );
        await validateWithFixes();
      }

      return await finish();
    } catch (err) {
      feedEmit?.({
        role: 'orchestrator',
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      sculptor?.dispose();
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * 从提示词绑定解析 Motion 卡各角色的会话模型：导演跟随 cards.animation 绑定、
 * 雕刻/审查跟随 cards.segment 绑定，转成 pi `--model` 引用。
 * 解析失败（未绑定 / 模型不在 provider / provider 无法投影）时返回 undefined，
 * 回退到 pi settings 默认——保持既有行为，不因绑定异常中断出卡。
 */
export function resolveMotionCardModels(
  settings: AISettings,
  projectBindings: PromptBindingMap | null,
): { directorModel?: string; sculptorModel?: string } {
  const pick = (kind: PromptKind): string | undefined => {
    try {
      const { provider, model } = resolvePromptBinding(kind, settings, projectBindings);
      return piModelRef(provider, model) ?? undefined;
    } catch {
      return undefined;
    }
  };
  return { directorModel: pick('cards.animation'), sculptorModel: pick('cards.segment') };
}
