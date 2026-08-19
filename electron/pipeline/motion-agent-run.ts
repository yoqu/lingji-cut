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
import { spawn } from 'node:child_process';
import type {
  MotionCardAgentContext,
  MotionCardAgentProvider,
  MotionCardAgentResult,
} from '../../src/lib/ai-analysis';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import { DEFAULT_ASSET_TREATMENT, type AssetResolutionResult, type CardAssetBinding } from '../../src/types/assets';
import type { FootageCompositionInput } from '../../src/types/footage';
import type { MotionCardMechanicalValidation } from '../../src/types/motion';
import type { PromptKind } from '../../src/lib/prompts/types';
import { resolvePromptBinding } from '../../src/lib/llm/binding-resolver';
import { piModelRef } from '../agent-runtime/pi-provider-projection';
import {
  parseStoryboard,
  storyboardParseHint,
  validateAgentCompositeStoryboard,
  validateStoryboard,
  formatStoryboardIssues,
} from '../../src/lib/motion-storyboard';
import { lintMotionCardTsx, formatLintIssues } from '../../src/lib/motion-card-lint';
import { buildFallbackCardTsx } from '../../src/lib/motion-card-fallback';
import { compileMotionCardFromStoryboard } from '../../src/lib/motion-card-templates';
import { resolveMotionCardPath } from './motion-hybrid';
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
  type PiHeadlessImage,
  type PiHeadlessCreateInput,
  type PiHeadlessStreamEvent,
} from '../agent-runtime/pi-headless';
import type { AgentFeedEmitInput, AgentFeedRole, AgentFeedStage } from './agent-feed';
import { ensurePiAgentRoles, loadPiAgentRole, type PiAgentRole } from '../agent-runtime/pi-agents-seed';
import { readLocalFileFingerprint } from '../footage/file-fingerprint';

export const MAX_STORYBOARD_ITER = 2;
/** 解析失败（回复不是合法 JSON）单独计预算，不烧语义回喂轮——弱导演常先输出散文/截断。 */
export const MAX_STORYBOARD_PARSE_RETRY = 2;
export const MAX_FIX_ITER = 3;
export const MAX_REVIEW_ITER = 2;
export const MAX_REVIEW_PARSE_RETRY = 2;

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

function reviewUnavailableReason(
  parsed: Partial<ReviewVerdict>,
  issues: ReviewVerdictIssue[],
): string | undefined {
  const explicitReason = typeof parsed.unavailableReason === 'string'
    ? parsed.unavailableReason.trim()
    : '';
  if (explicitReason) return explicitReason;

  const visualUnverified = issues.find((issue) => issue.code === 'visual-unverified');
  if (!visualUnverified) return undefined;
  return [
    visualUnverified.visualProblem,
    visualUnverified.message,
    visualUnverified.rule,
    visualUnverified.fix,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
    ?? '审查员明确标记 visual-unverified，未完成 contact sheet 视觉审片。';
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
    const unavailableReason = reviewUnavailableReason(parsed, issues);
    return {
      pass: !hasBlockingIssue,
      issues,
      ...(unavailableReason ? { unavailableReason } : {}),
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

function resolveMediaPath(filePath: string, projectPath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectPath, filePath);
}

async function compositionBindings(
  inputs: FootageCompositionInput[],
  projectPath: string,
): Promise<{
  bindings: CardAssetBinding[];
  issues: Array<{ severity: 'warning'; code: string; message: string }>;
}> {
  const bindings: CardAssetBinding[] = [];
  const issues: Array<{ severity: 'warning'; code: string; message: string }> = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const sourcePath = resolveMediaPath(input.asset.path, projectPath);
    const fingerprint = await readLocalFileFingerprint(sourcePath);
    const fingerprintMatches = Boolean(
      input.fileFingerprint
      && fingerprint
      && input.fileFingerprint === fingerprint,
    );
    if (!fingerprintMatches) {
      const reason = !input.fileFingerprint
        ? '缺少批准时文件指纹'
        : !fingerprint
          ? '文件不存在或无法读取'
          : '文件内容或修改时间已变化';
      if (input.usage === 'required') {
        throw new Error(`Agent 合成镜头必用素材已失效（${reason}）：${input.asset.filename}`);
      }
      issues.push({
        severity: 'warning',
        code: 'optional-composite-asset-invalid',
        message: `可选素材“${input.asset.filename}”已失效（${reason}），已从本镜头允许素材池移除。`,
      });
      continue;
    }
    bindings.push({
      slot: `media-${index + 1}`,
      assetId: input.asset.id,
      filePath: sourcePath,
      kind: input.asset.kind,
      usage: input.usage,
      required: input.usage === 'required',
      lockedByUser: true,
      trimStartMs: Math.max(0, Math.round(input.trimStartMs ?? (input.asset.matchedSegmentStart ?? 0) * 1000)),
      durationMs: typeof input.asset.durationSec === 'number' && Number.isFinite(input.asset.durationSec)
        ? Math.max(1, Math.round(input.asset.durationSec * 1_000))
        : undefined,
      thumbnailFile: input.asset.thumbnailFile,
      fileFingerprint: input.fileFingerprint,
      treatment: DEFAULT_ASSET_TREATMENT,
      // 仅满足旧 CardAssetBinding 的兼容形状；Agent 合成运行时不会读取或注入该 placement。
      placement: { x: 0, y: 0, width: 1920, height: 1080, depth: 'background' },
      metadata: {
        width: input.asset.pixelWidth ?? null,
        height: input.asset.pixelHeight ?? null,
        durationMs: typeof input.asset.durationSec === 'number' && Number.isFinite(input.asset.durationSec)
          ? Math.max(1, Math.round(input.asset.durationSec * 1_000))
          : null,
      },
    });
  }
  return { bindings, issues };
}

async function readImageAttachment(filePath: string): Promise<PiHeadlessImage | null> {
  try {
    const bytes = await fs.readFile(filePath);
    if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) return null;
    return { type: 'image', data: bytes.toString('base64'), mimeType: imageMime(filePath) };
  } catch {
    return null;
  }
}

async function extractVideoFrame(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  positionMs: number,
): Promise<boolean> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  return await new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegPath, [
      '-y', '-v', 'error', '-ss', (Math.max(0, positionMs) / 1000).toFixed(3), '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-q:v', '3', outputPath,
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

interface AgentVisualEvidence {
  images: PiHeadlessImage[];
  labels: string[];
  visualizedSlots: Set<string>;
  issues: Array<{ severity: 'warning'; code: string; message: string }>;
}

async function prepareAgentVisualEvidence(
  bindings: CardAssetBinding[],
  projectPath: string,
  workDir: string,
  ffmpegPath?: string | null,
): Promise<AgentVisualEvidence> {
  const images: PiHeadlessImage[] = [];
  const labels: string[] = [];
  const visualizedSlots = new Set<string>();
  const issues: AgentVisualEvidence['issues'] = [];
  const orderedBindings = [...bindings].sort((left, right) => {
    const leftRequired = left.usage === 'required' || left.required === true;
    const rightRequired = right.usage === 'required' || right.required === true;
    return Number(rightRequired) - Number(leftRequired);
  });
  const appendVideoFrame = async (
    binding: CardAssetBinding,
    sourcePath: string,
    offsetMs: number,
    suffix: string,
    label: string,
  ): Promise<boolean> => {
    if (!ffmpegPath || images.length >= 8) return false;
    const output = path.join(workDir, 'visual-evidence', `${binding.slot}-${suffix}.jpg`);
    if (!await extractVideoFrame(ffmpegPath, sourcePath, output, Math.max(0, binding.trimStartMs ?? 0) + offsetMs)) {
      return false;
    }
    const image = await readImageAttachment(output);
    if (!image) return false;
    images.push(image);
    labels.push(`${binding.slot}：${label}`);
    visualizedSlots.add(binding.slot);
    return true;
  };

  // 第一轮保证每个素材至少得到一张视觉附件，避免前置视频的多帧占满 8 张预算。
  for (const binding of orderedBindings) {
    if (images.length >= 8) break;
    const sourcePath = resolveMediaPath(binding.filePath, projectPath);
    if (binding.kind !== 'video') {
      const image = await readImageAttachment(sourcePath);
      if (image) {
        images.push(image);
        labels.push(`${binding.slot}：图片原图`);
        visualizedSlots.add(binding.slot);
      }
      continue;
    }
    await appendVideoFrame(binding, sourcePath, 0, 'primary', '视频代表帧 1/3');
    if (!visualizedSlots.has(binding.slot) && binding.thumbnailFile) {
      const thumbnailPath = resolveMediaPath(binding.thumbnailFile, projectPath);
      const thumbnail = await readImageAttachment(thumbnailPath);
      if (thumbnail) {
        images.push(thumbnail);
        labels.push(`${binding.slot}：视频素材缩略帧`);
        visualizedSlots.add(binding.slot);
      }
    }
    if (!visualizedSlots.has(binding.slot)) {
      issues.push({
        severity: 'warning',
        code: 'composite-video-preview-unavailable',
        message: `视频素材“${binding.slot}”无法抽取代表帧，Agent 无法可靠判断构图。`,
      });
    }
  }

  // 第二轮只在所有素材都有首张证据后补视频中段/尾段，供 Agent 判断运动与裁剪方向。
  for (const binding of orderedBindings) {
    if (images.length >= 8) break;
    if (binding.kind !== 'video' || !visualizedSlots.has(binding.slot)) continue;
    const sourcePath = resolveMediaPath(binding.filePath, projectPath);
    const spanMs = Math.max(1_000, binding.durationMs ?? 5_000);
    await appendVideoFrame(binding, sourcePath, Math.min(spanMs / 2, 2_500), 'middle', '视频代表帧 2/3');
    await appendVideoFrame(
      binding,
      sourcePath,
      Math.min(Math.max(0, spanMs - 150), 5_000),
      'tail',
      '视频代表帧 3/3',
    );
  }
  return { images, labels, visualizedSlots, issues };
}

function compositeContract(
  ctx: MotionCardAgentContext,
  bindings: CardAssetBinding[],
  labels: string[],
): string {
  if (ctx.renderStrategy !== 'agent-composite') return '';
  const intent = ctx.compositionIntent;
  return [
    '===== Agent 原子合成镜头锁定契约 =====',
    '本镜头不是外部素材层叠加 Motion Card，而是一个完整 React/Remotion 组件。空间布局、裁切、蒙版、层级与时序由你根据叙事自行决定，不套用画中画/分屏模板。',
    '本契约覆盖普通 Motion Card 的固定 storyboard 规则。导演只输出 claim、scene、focus:{beat,subject}、beats、media:[{assetId,slot,purpose,beats}]；不要输出 layout、elements、capacity 或为了 MotionSlot 编造 lifecycle。雕刻师直接按语义分镜开发完整场景。',
    `叙事目标：${intent?.narrativeGoal || '结合口播建立清晰视觉论证'}`,
    `视觉焦点：${intent?.focalPriority || '真实素材与核心观点共同服务口播'}`,
    `时间关系：${intent?.temporalRelationship || '按口播节拍组织素材与图形的出现关系'}`,
    `必须呈现：${intent?.mustShow?.join('；') || '已标 required 的真实素材'}`,
    `禁止事项：${intent?.avoid?.join('；') || '不得替换锁定素材；不得用生成画面冒充事实证据'}`,
    '运行时组件 props 会提供 mediaAssets 与 BoundMedia。mediaAssets 每项含 slot/assetId/kind/src/usage/required/lockedByUser/trimStartMs/durationMs/metadata，不含路径或 placement；所有上屏素材统一使用 <BoundMedia slot="media-1" style={...} />，尤其 required 不得绕过 BoundMedia 直接读取 src。视频必须 muted。',
    ...bindings.map((binding, index) =>
      `${index + 1}. slot=${binding.slot}；kind=${binding.kind ?? 'image'}；usage=${binding.usage ?? (binding.required ? 'required' : 'optional')}；trimStartMs=${binding.trimStartMs ?? 0}；assetId=${binding.assetId}`,
    ),
    labels.length > 0 ? `本轮图片附件顺序：${labels.join('；')}` : '本轮没有可读取的素材画面附件。',
    'required 素材必须通过 BoundMedia 在关键画面中真实可见（质量门禁会逐项检查）；optional 可按叙事判断是否采用，但素材池全为 optional 时仍必须至少采用一项，合成镜头不得退化为纯 Motion。不得引用未绑定素材、绝对路径、网络资源或 base64。',
    'SafeLayout/MotionSlot 仅可作为局部信息图能力，不是本镜头的布局约束；允许使用 AbsoluteFill、absolute、clipPath、mask、transform 等完成一体化构图。',
  ].join('\n');
}

function buildStandaloneCompositeFallbackTsx(): string {
  return `import React from 'react';
import { AbsoluteFill } from 'remotion';

export default function CompositeFallback({ BoundMedia, mediaAssets = [] }) {
  const required = mediaAssets.find((asset) => asset.required) ?? mediaAssets[0];
  if (!required || !BoundMedia) {
    return <AbsoluteFill style={{ backgroundColor: '#101827' }} />;
  }
  return (
    <AbsoluteFill style={{ backgroundColor: '#101827', overflow: 'hidden' }}>
      <BoundMedia
        assetId={required.assetId}
        fit="cover"
        muted
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
    </AbsoluteFill>
  );
}`;
}

async function prepareContactSheetAssets(
  bindings: CardAssetBinding[],
  projectPath: string,
): Promise<{ bindings: CardAssetBinding[]; issues: Array<{ severity: 'warning'; code: string; message: string }> }> {
  const issues: Array<{ severity: 'warning'; code: string; message: string }> = [];
  const prepared = await Promise.all(bindings.map(async (binding) => {
    if (binding.kind === 'video') {
      if (!binding.thumbnailFile || /^(data:|https?:)/i.test(binding.thumbnailFile)) return binding;
      const thumbnailPath = path.isAbsolute(binding.thumbnailFile)
        ? binding.thumbnailFile
        : path.resolve(projectPath, binding.thumbnailFile);
      try {
        const bytes = await fs.readFile(thumbnailPath);
        return {
          ...binding,
          thumbnailFile: `data:${imageMime(thumbnailPath)};base64,${bytes.toString('base64')}`,
        };
      } catch {
        return binding;
      }
    }
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
  /** Agent 合成的导演/雕刻与所有 contact sheet 审片使用的视觉模型候选。 */
  visualModelCandidates?: string[];
  /** 阶段回调（导演/雕刻/验证/审查/修复），供任务进度映射。 */
  onPhase?: (phase: string) => void;
  /** 观测事件回调（角色流式输出/工具调用/编排里程碑），供渲染端观测面板。 */
  onAgentEvent?: (ev: AgentFeedEmitInput) => void;
  /** 可选：生成关键帧 contact sheet PNG 的缓存目录；不传则只记录关键帧索引。 */
  contactSheetCacheDir?: string;
  /** 可选：为视频组合素材抽取代表帧；缺失时退回素材缩略图。 */
  ffmpegPath?: string | null;
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
    visualModelCandidates = [],
    onPhase,
    onAgentEvent,
    contactSheetCacheDir,
    ffmpegPath,
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
              } else if (ev.type === 'tool_result') {
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
        ...motionPathExtra,
        ...extra,
      });
    };
    // 出卡路径决议的 telemetry 附加字段；在分支点赋值，分支后的 emit / card.compile.* 携带。
    let motionPathExtra: Record<string, unknown> = {};
    // 传输层容错：provider 截断 / 网络抖动（如 "Unexpected end of JSON input"）重试一次，
    // 不让单次瞬时故障直接判死整张卡。
    const promptWithRetry = async (
      session: Pick<PiHeadlessSession, 'prompt'>,
      text: string,
      images?: PiHeadlessImage[],
      requireImages = false,
    ): Promise<string> => {
      try {
        return await session.prompt(text, images);
      } catch (err) {
        throwIfAborted();
        emit('prompt-retry', false, { error: err instanceof Error ? err.message : String(err) });
        try {
          return await session.prompt(text, images);
        } catch (retryError) {
          if (!requireImages && images?.length) return await session.prompt(text);
          throw retryError;
        }
      }
    };

    let sculptor: Awaited<ReturnType<typeof createSession>> | null = null;
    try {
      const isComposite = ctx.renderStrategy === 'agent-composite';
      const uniqueModels = (...models: Array<string | undefined>): string[] =>
        [...new Set(models.filter((model): model is string => Boolean(model)))];
      const compositeDirectorModels = uniqueModels(...visualModelCandidates, directorModel);
      const compositeSculptorModels = uniqueModels(sculptorModel, ...visualModelCandidates);
      const lockedComposition = isComposite
        ? await compositionBindings(ctx.compositionInputs ?? [], opts.projectPath)
        : { bindings: [] as CardAssetBinding[], issues: [] as AgentVisualEvidence['issues'] };
      if (isComposite && lockedComposition.bindings.length === 0) {
        throw new Error('Agent 合成镜头没有可用的已批准素材，已按 block 语义停止制作。');
      }
      const agentVisuals = isComposite
        ? await prepareAgentVisualEvidence(
            lockedComposition.bindings,
            opts.projectPath,
            workDir,
            ffmpegPath,
          )
        : { images: [], labels: [], visualizedSlots: new Set<string>(), issues: [] };
      const missingRequiredVisual = lockedComposition.bindings.find(
        (binding) => (binding.usage === 'required' || binding.required) && !agentVisuals.visualizedSlots.has(binding.slot),
      );
      if (missingRequiredVisual) {
        throw new Error(`必用素材“${missingRequiredVisual.slot}”无法形成视觉附件，Agent 合成已阻塞。`);
      }
      const compositeBrief = compositeContract(ctx, lockedComposition.bindings, agentVisuals.labels);
      const validateDirection = (
        storyboard: ReturnType<typeof parseStoryboard>,
        attempt = 0,
      ) => isComposite
        ? validateAgentCompositeStoryboard(storyboard, {
            cueCount: ctx.cueCount ?? 0,
            transcript: ctx.segmentTranscript,
            approvedAssets: lockedComposition.bindings.map((binding) => ({
              assetId: binding.assetId,
              slot: binding.slot,
              usage: binding.usage ?? (binding.required ? 'required' : 'optional'),
            })),
          })
        : validateStoryboard(storyboard, {
            attempt,
            cueCount: ctx.cueCount ?? 0,
            transcript: ctx.segmentTranscript,
            requireCapacityModel: true,
            semanticType: ctx.semanticType,
            bibleDirective: ctx.motionBibleDirective,
          });

      // ── 1. 导演：JSON 分镜 + 机器校验回喂 ─────────────────────────────────────
      let direction = '';
      const storyboardDraft = parseStoryboard(ctx.animationDirectionDraft ?? '');
      const storyboardDraftVerdict = validateDirection(storyboardDraft);
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
          model: isComposite ? compositeDirectorModels[0] : directorModel,
          ...(isComposite ? {
            modelCandidates: compositeDirectorModels,
            requireImageInput: true,
          } : {}),
          ...roleStream('director', isComposite ? compositeDirectorModels[0] : directorModel),
        });
        try {
        const parts = [ctx.buildDirectorPrompt()];
        if (compositeBrief) parts.push(compositeBrief);
        if (ctx.animationDirectionDraft) {
          parts.push(`===== 用户已有的动画指导草案（保留其载体与节拍意图，补全为合法 storyboard）=====\n${ctx.animationDirectionDraft}`);
        }
        if (ctx.existingTsx) {
          parts.push(
            `===== 现有组件源码（精雕模式：先诊断其设计问题——载体选错 / 状态演进缺失 / 焦点不明 / 节拍脱节，分镜须针对性修正）=====\n\`\`\`tsx\n${ctx.existingTsx}\n\`\`\``,
          );
        }
        const FIELD_EXAMPLE = isComposite
          ? `{"claim":"...","scene":"真实素材与信息图形形成连续视觉论证","focus":{"beat":1,"subject":"核心事实"},"beats":[{"cue":null,"kind":"build","role":"anticipation","adds":"建立真实场景","motion":"素材进入并留下信息空间"},{"cue":1,"kind":"accent","role":"emphasis","adds":"核心事实","changes":"图形回应素材中的证据","motion":"焦点随口播落定"}],"media":[{"assetId":"approved-asset-id","slot":"media-1","purpose":"作为事实证据并与核心观点建立关系","beats":[0,1]}]}`
          : `{"claim":"...","carrier":"data-hero","layout":"title-hero","scene":"...","data":{"value":28842,"unit":"人","label":"考研报名"},"elements":[{"id":"title","role":"support","slot":"header","content":"考研报名","heightRatio":0.12},{"id":"hero","role":"focus","slot":"main","content":"28842人","heightRatio":0.42}],"capacity":{"maxVisible":2,"maxHeightRatio":0.62},"focus":{"beat":1,"emphasis":"countup-settle"},"beats":[{"cue":null,"kind":"build","adds":"标题「考研报名」","motion":"软落入场","lifecycle":{"enter":["title"]}},{"cue":2,"kind":"build","adds":"数字 28842","changes":"标题收为辅助，数字成为焦点","motion":"计数到 28842","lifecycle":{"enter":["hero"],"collapse":["title"]}}]}`;
        let reply = (
          await promptWithRetry(director, parts.join('\n\n'), agentVisuals.images, isComposite)
        ).trim();
        // 解析失败与语义失败分开计预算：解析重试只需"重新输出 JSON"，
        // 不该消耗针对 cue/数字等设计错误的语义回喂轮（弱导演常先散文/截断再给对 JSON）。
        let parseRounds = 0;
        let semanticRounds = 0;
        for (;;) {
          throwIfAborted();
          const storyboard = parseStoryboard(reply);
          const verdictSb = validateDirection(storyboard, semanticRounds);
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
      let resolvedAssetBindings: CardAssetBinding[] = [...lockedComposition.bindings];
      let assetResolution: AssetResolutionResult = { bindings: [], generationRequests: [], unresolved: [] };
      if (!isComposite && storyboardForAssets?.assets?.length && ctx.resolveAssets) {
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
            // layout 穿透：asset-aside / asset-led 的主资产 placement 与编译器网格资产格严格对齐。
            layout: storyboardForAssets.layout,
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

      if (isComposite && storyboardForAssets?.assets?.length) {
        milestone('Agent 合成镜头忽略分镜新增资产请求，仅使用批准时冻结的素材池');
      }

      const storyboard = storyboardForAssets ?? parseStoryboard(direction);
      // 素材物化结果挂到既有 card.compile 事件 extra（不新造日志）：
      // 物化失败 → assetsResolved=false → 编译器退回纯文字布局，此处让降级可观测。
      const assetsResolved = resolvedAssetBindings.length > 0;
      const assetTelemetryExtra = isComposite
        ? {
            assetRequested: ctx.compositionInputs?.length ?? 0,
            assetResolved: resolvedAssetBindings.length,
            assetUnresolved: Math.max(0, (ctx.compositionInputs?.length ?? 0) - resolvedAssetBindings.length),
            composite: true,
          }
        : storyboard?.assets?.length
        ? {
            assetRequested: storyboard.assets.length,
            assetResolved: resolvedAssetBindings.length,
            assetUnresolved: assetResolution.unresolved.length + assetResolution.generationRequests.length,
          }
        : {};
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
        qualityProfile: isComposite ? 'agent-composite' as const : 'motion-card' as const,
        checkRenderedLayout: true,
      };

      // ── 2. 出卡路径分支 ─────────────────────────────────────────────────────────
      // template（默认）：storyboard 确定性编译 → 机械质检一次，不经 LLM 雕刻/审查；
      // agent：LLM 雕刻 → 修复循环 → 审查（精雕 existingTsx 或显式 agent 模式）；
      // hybrid：重点段 agent、普通段 template——批量预选决议（含每期上限）优先，
      // 单卡路径（重生成/转换/手动选段）按段信号规则兜底，缺信号回落 template。
      const pathDecision = isComposite
        ? { path: 'agent' as const, reasons: ['Agent 合成镜头强制自由编排'] }
        : resolveMotionCardPath(ctx);
      const templateMode = pathDecision.path === 'template';
      const motionPathReason = pathDecision.reasons.join('；');
      motionPathExtra = {
        motionPath: pathDecision.path,
        ...(ctx.motionCardMode === 'hybrid'
          ? { motionPathReason: motionPathReason || '未命中精雕规则' }
          : {}),
      };
      if (ctx.motionCardMode === 'hybrid') {
        milestone(
          `hybrid 判定：本段走${pathDecision.path === 'agent' ? ' Agent 精雕' : '模板编译'}（${motionPathReason || '未命中精雕规则'}）`,
        );
      }

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
          if (isComposite && (ctx.fallbackPolicy ?? 'block') === 'block') return false;
          const storyboard = parseStoryboard(direction);
          if (!storyboard) return false;
          const compositeMotionFallback = isComposite && ctx.fallbackPolicy === 'motion';
          const fallbackTsx = isComposite && ctx.fallbackPolicy === 'standalone-media'
            ? buildStandaloneCompositeFallbackTsx()
            : buildFallbackCardTsx(storyboard, ctx.presetMotionTokens ?? '{}', { assetsResolved });
          const lint = lintMotionCardTsx(fallbackTsx, {
            requireSafeLayout: compositeMotionFallback || (!isComposite && ctx.qualityMode !== 'director'),
          });
          if (!lint.ok) {
            emit('fallback', false, { error: formatLintIssues(lint.issues).slice(0, 200) });
            return false;
          }
          const validation = await ctx.validate?.(fallbackTsx, compositeMotionFallback
            ? { ...validationInput, assetBindings: [], qualityProfile: 'motion-card' }
            : validationInput);
          latestLayoutIssues = validation?.issues ?? [];
          await fs.writeFile(tsxPath, fallbackTsx, 'utf-8');
          tsx = fallbackTsx;
          fallbackUsed = true;
          emit('fallback', true, { reason: lastProblem.slice(0, 160) });
          milestone(isComposite
            ? `Agent 合成未通过质量门禁，已按 ${ctx.fallbackPolicy} 策略明确降级`
            : 'LLM 雕刻未能通过校验，已由分镜确定性编译兜底卡');
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
      let visualReviewCompleted = false;
      const contactSheetAssets = await prepareContactSheetAssets(resolvedAssetBindings, opts.projectPath);
      const assetIssues = [
        ...lockedComposition.issues,
        ...agentVisuals.issues,
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
            qualityProfile: isComposite ? 'agent-composite' : 'motion-card',
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
        if (contactSheetPath) return '关键帧 contact sheet 已生成但无法作为图片附件读取。';
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
            visualReviewAvailable: visualReviewCompleted,
            unavailableReason:
              visualReviewCompleted ? undefined : reviewUnavailableReason ??
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
        ctx.telemetry?.emit('card.compile.start', { segmentId: ctx.segmentId, carrier: storyboard?.carrier, ...motionPathExtra });
        let compileProblem: string | null = null;
        if (!storyboard) {
          compileProblem = '分镜解析失败，无法模板编译';
        } else {
          try {
            tsx = compileMotionCardFromStoryboard(storyboard, ctx.presetMotionTokens ?? '{}', { assetsResolved });
            const lint = lintMotionCardTsx(tsx, {
              requireSafeLayout: !isComposite && ctx.qualityMode !== 'director',
            });
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
            ...motionPathExtra,
            ...assetTelemetryExtra,
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
            ...motionPathExtra,
            ...assetTelemetryExtra,
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
        model: isComposite ? compositeSculptorModels[0] : sculptorModel,
        ...(isComposite ? {
          modelCandidates: compositeSculptorModels,
          requireImageInput: true,
        } : {}),
        ...roleStream('sculptor', isComposite ? compositeSculptorModels[0] : sculptorModel),
      });
      const sculptParts = [
        ctx.buildCardPrompt(direction, resolvedAssetBindings),
        ...(compositeBrief ? [compositeBrief] : []),
        `===== 本段口播逐字稿（内容忠实的唯一来源）=====\n${ctx.segmentTranscript}`,
        ctx.existingTsx
          ? `===== 执行 =====\n工作目录已有 motionCard.tsx（现有实现）。按任务书与分镜用 edit 工具针对性改造它；改造完成即停止。`
          : `===== 执行 =====\n用 write 工具把完整组件写入 ./motionCard.tsx；写完即停止。`,
      ];
      await promptWithRetry(sculptor, sculptParts.join('\n\n'), agentVisuals.images, isComposite);

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
            const lint = lintMotionCardTsx(tsx, {
              requireSafeLayout: !isComposite && ctx.qualityMode !== 'director',
            });
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
                isComposite
                  ? [
                      `===== 多轮修复仍未通过校验，执行合成镜头简化重写 =====`,
                      `剩余问题：\n${problem}`,
                      `保留 required 的 BoundMedia，删除次要装饰和可选素材；把真实素材作为唯一主视觉，只保留一个与口播同步的核心图形/短文案。`,
                      `仍然输出一个原子组件，不得改成外部素材层，不得替换绑定素材。`,
                    ].join('\n')
                  : [
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

      const buildVisualEvidencePrompt = async (): Promise<{ text: string; images: PiHeadlessImage[] }> => {
        await updateContactSheet();
        const image = contactSheetPath ? await readImageAttachment(contactSheetPath) : null;
        return { text: [
          `===== 关键帧审片材料（contact sheet）=====`,
          `关键帧 frame index：${framesChecked.join(', ') || '无'}`,
          image
            ? `contact sheet PNG：已作为本条消息的图片附件提供${contactSheetCached ? '（缓存命中）' : '（本轮生成）'}`
            : `contact sheet PNG：不可用（${visualReviewUnavailableReason()}）`,
          `图片附件存在时必须按画面审查；不存在时不要声称完成视觉审片，只能按文本推断并写成 warn。`,
        ].join('\n'), images: image ? [image] : [] };
      };

      const reviewerRole = await loadRole('card-reviewer');
      for (;;) {
        // 兜底卡是确定性模板产物，设计审查没有可改空间，直接收尾。
        if (fallbackUsed) break;
        throwIfAborted();
        setPhase('审查', 'review');
        const visualEvidence = await buildVisualEvidencePrompt();
        const reviewerModels = uniqueModels(...visualModelCandidates, sculptorModel, directorModel);
        const reviewer = await createSession({
          systemPrompt: reviewerRole.systemPrompt,
          tools: [],
          cwd: workDir,
          signal,
          model: reviewerModels[0] ?? sculptorModel,
          ...(visualEvidence.images.length > 0 ? {
            modelCandidates: reviewerModels,
            requireImageInput: true,
          } : {}),
          ...roleStream('reviewer', reviewerModels[0] ?? sculptorModel),
        });
        let verdict: ReviewVerdict;
        try {
          const reviewPrompt = [
            `===== 导演的 JSON 分镜（storyboard，设计蓝图）=====\n${direction}`,
            ctx.motionBible ? ctx.motionBible : `Motion Bible：无（按单卡分镜独立审查）。`,
            ctx.reviewStyleBlock
              ? `===== 风格生产细则（偏差记 style-fidelity warn）=====\n${ctx.reviewStyleBlock}`
              : `风格生产细则：无。`,
            ctx.reviewContentTypeBlock
              ? `===== 内容类型生产规则（偏差记 carrier-fidelity/style-fidelity warn）=====\n${ctx.reviewContentTypeBlock}`
              : `内容类型生产规则：无。`,
            ...(compositeBrief ? [compositeBrief] : []),
            `===== 机械校验结论 =====\n已通过（静态 lint + 编译 + 冒烟渲染 + 布局探针含字幕安全区）；机械规则不必复查，只判设计兑现度。`,
            visualEvidence.text,
            `===== motionCard.tsx =====\n\`\`\`tsx\n${tsx}\n\`\`\``,
          ].join('\n\n');
          let reviewReply = await promptWithRetry(
            reviewer,
            reviewPrompt,
            visualEvidence.images,
            isComposite,
          );
          verdict = parseReviewVerdict(reviewReply);
          for (let parseRound = 0;
            verdict.issues.some((issue) => issue.code === 'review-unavailable')
              && parseRound < MAX_REVIEW_PARSE_RETRY;
            parseRound += 1) {
            setPhase(`审查重出（解析失败 ${parseRound + 1}/${MAX_REVIEW_PARSE_RETRY}）`, 'review', parseRound + 1);
            milestone(`审查回复无法解析，要求审查员仅重出 JSON（${parseRound + 1}/${MAX_REVIEW_PARSE_RETRY}）`);
            reviewReply = await promptWithRetry(
              reviewer,
              [
                `上一条回复无法解析。你已经收到并审看了上一条消息中的 contact sheet，现在只重出裁决 JSON。`,
                `不要解释、不要 markdown 围栏、不要重复分析过程。`,
                `通过时：{"pass":true,"issues":[]}`,
                `有问题时：{"pass":false,"issues":[{"code":"focus-missing","element":"...","rule":"...","fix":"...","frame":0,"beat":0,"visualProblem":"..."}]}`,
                `只有确实无法读取图片时才可输出 unavailableReason 和 visual-unverified。`,
              ].join('\n'),
            );
            verdict = parseReviewVerdict(reviewReply);
          }
        } finally {
          reviewer.dispose();
        }
        finalReviewIssues = verdict.issues;
        visualReviewCompleted = visualEvidence.images.length > 0 && !verdict.unavailableReason;
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

      if (isComposite && !fallbackUsed && !visualReviewCompleted) {
        throw new Error(
          `Agent 合成镜头未完成多模态审片，已阻止进入 Animatic：${reviewUnavailableReason ?? visualReviewUnavailableReason()}`,
        );
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

/**
 * 视觉角色候选：优先复用总导演/规划的多模态模型，再回落到单卡模型。
 * 最终是否支持 image 由 Pi ModelRuntime 实时校验，不信任配置字符串。
 */
export function resolveMotionCardVisualModelCandidates(
  settings: AISettings,
  projectBindings: PromptBindingMap | null | undefined,
): string[] {
  const candidates: string[] = [];
  const add = (kind: PromptKind) => {
    try {
      const { provider, model } = resolvePromptBinding(kind, settings, projectBindings ?? null);
      const ref = piModelRef(provider, model);
      if (ref && !candidates.includes(ref)) candidates.push(ref);
    } catch {
      // Continue with the next compatible binding.
    }
  };
  const hasExplicitDirector = [
    projectBindings?.['production.director'],
    settings.promptBindings?.['production.director'],
  ].some((binding) => Boolean(
    (typeof binding?.providerId === 'string' && binding.providerId.trim())
    || (typeof binding?.model === 'string' && binding.model.trim()),
  ));
  if (hasExplicitDirector) add('production.director');
  add('planning.segment');
  add('cards.segment');
  add('cards.animation');
  const defaultProvider = settings.llmProviders?.find(
    (provider) => provider.id === settings.defaultProviderId,
  );
  const defaultModel = defaultProvider?.models.includes(defaultProvider.defaultModel ?? '')
    ? defaultProvider.defaultModel
    : settings.defaultModel;
  if (defaultProvider && defaultModel) {
    const ref = piModelRef(defaultProvider, defaultModel);
    if (ref && !candidates.includes(ref)) candidates.push(ref);
  }
  return candidates;
}
