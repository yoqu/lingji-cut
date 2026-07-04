/**
 * runtime-registry.ts
 *
 * RuntimeRegistry — 多协议 Agent Runtime 的多会话管理 + 归一化事件转发层。
 *
 * 取代旧 `electron/acp/connection-registry.ts`。对外接口/事件刻意对齐旧的，
 * 使 A10 切换 ipc 时改动最小：
 *   - 方法：connect / sendPrompt / cancelTurn / disconnect / disconnectAll /
 *           setPermissionPolicy / setMode / setConfigOption / respondPermission /
 *           list / get / size
 *   - 事件（按 conversationId 维度）：
 *       'status'  → { conversationId, status }
 *       'event'   → { conversationId, event }  （event 为 Renderer 消费形状）
 *
 * ── 连接模型折中（ACP 持久会话 vs CLI 每轮 spawn） ───────────────────────────
 *   旧 ACP：先 connect 建持久会话，再多次 sendPrompt。
 *   多协议 CLI（claude/codex）：通常每个 prompt spawn 一次进程跑一轮。
 *   折中方案：
 *     - connect 只登记会话上下文（def / cwd / model / sessionId 等），不 spawn，
 *       状态置为 'connected'。
 *     - sendPrompt 时 new AgentSession（经 createSession 工厂）并 start 跑一轮；
 *       该轮 AgentSession.onEvent → toRuntimeEvent → emit 'event'。
 *     - 轮内状态置 'prompting'；turn_end / error 后回落 'connected'。
 *   resume：透传记录的 sessionId 作为 resumeSessionId。
 */

import { EventEmitter } from 'node:events';
import { AgentSession } from './session';
import type { AgentSessionStartInput } from './session';
import type { AgentStreamEvent } from './event-model';
import { toRuntimeEvent } from './event-model';
import { getAgentDef } from './registry';
import type { RuntimeAgentDef } from './types';
import type { ResolvedAgentSkill } from '../acp/types';

// ─── 状态与事件 payload（对齐旧 connection-registry） ────────────────────────

export type RuntimeStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'prompting'
  | 'error';

export interface RuntimeConnectInput {
  conversationId: number;
  agentType: string; // 'claude' | 'codex' | 'pi'
  projectDir: string;
  model?: string;
  /** resume：续轮 sessionId（pi 会话 externalId）。 */
  sessionId?: string | null;
  env?: Record<string, string>;
  permissionPolicy?: string;
  /** 连接期解析出的启用 skills。 */
  skills?: ResolvedAgentSkill[];
}

export interface RuntimeSnapshot {
  conversationId: number;
  projectDir: string;
  agentType: string;
  status: RuntimeStatus;
  sessionId: string | null;
}

export interface RuntimeStatusPayload {
  conversationId: number;
  status: RuntimeStatus;
}

export interface RuntimeEventPayload {
  conversationId: number;
  event: Record<string, unknown>;
}

// ─── 可注入的 AgentSession 抽象（便于单测） ──────────────────────────────────

export interface AgentSessionLike {
  start(input: AgentSessionStartInput): Promise<void>;
  cancel(): void;
  /** 响应一次挂起的审批请求（pi 路径有实现；其它协议可缺省）。 */
  respondPermission?(requestId: string, optionId: string): void;
}

interface RuntimeContextEntry {
  snapshot: RuntimeSnapshot;
  def: RuntimeAgentDef;
  model?: string;
  /** 思考程度（reasoning effort）；每轮可热切，沿用至后续轮。 */
  reasoning?: string;
  env?: Record<string, string>;
  /** 连接期解析出的启用 skills（每轮透传给 session.start）。 */
  skills?: ResolvedAgentSkill[];
  /** 当前活跃的轮会话（仅在 prompting 期间存在） */
  activeSession: AgentSessionLike | null;
}

interface RuntimeRegistryOptions {
  /** 可注入的 AgentSession 工厂；默认 () => new AgentSession()。 */
  createSession?: () => AgentSessionLike;
  /** @deprecated 旧子进程探测依赖；in-process 后已忽略（ipc.ts 仍传入，兼容保留）。 */
  binaryManager?: unknown;
  defaultPermissionPolicy?: string;
}

// ─── RuntimeRegistry ─────────────────────────────────────────────────────────

export class RuntimeRegistry extends EventEmitter {
  private readonly contexts = new Map<number, RuntimeContextEntry>();
  private readonly createSession: () => AgentSessionLike;
  private permissionPolicy: string;

  constructor(options: RuntimeRegistryOptions = {}) {
    super();
    this.permissionPolicy = options.defaultPermissionPolicy ?? 'tiered';
    this.createSession = options.createSession ?? (() => new AgentSession());
  }

  size(): number {
    return this.contexts.size;
  }

  list(): RuntimeSnapshot[] {
    return Array.from(this.contexts.values(), (entry) => ({ ...entry.snapshot }));
  }

  get(conversationId: number): RuntimeSnapshot | null {
    const entry = this.contexts.get(conversationId);
    return entry ? { ...entry.snapshot } : null;
  }

  /**
   * 登记会话上下文（不 spawn）。已存在则覆盖（先 disconnect 旧的）。
   */
  async connect(input: RuntimeConnectInput): Promise<RuntimeSnapshot> {
    const def = getAgentDef(input.agentType);
    if (!def) {
      throw new Error(`Unknown agent type: "${input.agentType}"`);
    }

    if (this.contexts.has(input.conversationId)) {
      this.disconnect(input.conversationId);
    }

    const snapshot: RuntimeSnapshot = {
      conversationId: input.conversationId,
      projectDir: input.projectDir,
      agentType: input.agentType,
      status: 'connected',
      sessionId: input.sessionId ?? null,
    };
    const entry: RuntimeContextEntry = {
      snapshot,
      def,
      model: input.model,
      env: input.env,
      skills: input.skills,
      activeSession: null,
    };
    this.contexts.set(input.conversationId, entry);

    this.emitStatus(input.conversationId, 'connected');
    return { ...snapshot };
  }

  /**
   * 起一轮：new AgentSession → start。contents 文本化为 prompt。
   * onEvent → toRuntimeEvent → emit 'event'（非 null）。
   * turn_end / error 后回落 'connected' 并清理 activeSession。
   */
  async sendPrompt(
    conversationId: number,
    contents: unknown[],
    opts?: { model?: string; reasoning?: string },
  ): Promise<void> {
    const entry = this.getEntryOrThrow(conversationId);

    // 每轮可热切 model / reasoning：opts 覆盖登记值并回写，后续轮沿用，
    // 与芯片受控选择保持一致。
    if (opts?.model) {
      entry.model = opts.model;
    }
    if (opts?.reasoning) {
      entry.reasoning = opts.reasoning;
    }

    const prompt = stringifyContents(contents);
    const session = this.createSession();
    entry.activeSession = session;

    this.setStatus(entry, 'prompting');

    let settled = false;
    const settle = (status: RuntimeStatus) => {
      if (settled) return;
      settled = true;
      if (entry.activeSession === session) {
        entry.activeSession = null;
      }
      // 仅在该轮仍是当前上下文时回落状态（disconnect 后不再发）
      if (this.contexts.get(conversationId) === entry) {
        this.setStatus(entry, status);
      }
    };

    const onEvent = (ev: AgentStreamEvent) => {
      // 回写本轮新建/恢复出的 session id：driver 在起轮时上报 { type:'status',
      // sessionId }（pi-inprocess createAgentSession 后 emit）。把它写回快照，
      // 后续轮才能以 resumeSessionId 续接同一会话——pi 据此 open 历史会话文件，
      // 由 buildSessionContext 把完整上下文历史重放给模型。
      // 不回写则每轮 resumeSessionId 恒为 connect 时的旧值（新建会话为 null），
      // 导致 pi 每轮新建空会话、丢失上一轮对话记忆。
      if (ev.type === 'status' && ev.sessionId) {
        entry.snapshot.sessionId = ev.sessionId;
      }
      const out = toRuntimeEvent(ev);
      if (out) {
        this.emit('event', {
          conversationId,
          event: out as unknown as Record<string, unknown>,
        } satisfies RuntimeEventPayload);
      }
      if (ev.type === 'turn_end') {
        settle('connected');
      } else if (ev.type === 'error') {
        settle('error');
      }
    };

    try {
      await session.start({
        def: entry.def,
        prompt,
        cwd: entry.snapshot.projectDir,
        model: entry.model ?? entry.def.defaultModel,
        reasoning: entry.reasoning ?? entry.def.defaultReasoning,
        env: entry.env,
        skills: entry.skills,
        // live getter：审批策略运行时可热切，confirm 门控时读最新值。
        getPermissionPolicy: () => this.permissionPolicy,
        resumeSessionId: entry.snapshot.sessionId,
        isResuming: Boolean(entry.snapshot.sessionId),
        onEvent,
      });
    } catch (err) {
      // start() 抛错（spawn 失败等）→ error 终态。
      const message = err instanceof Error ? err.message : String(err);
      this.emit('event', {
        conversationId,
        event: { type: 'error', message } as Record<string, unknown>,
      } satisfies RuntimeEventPayload);
      settle('error');
      return;
    }

    // 注意：AgentSession.start() 只挂监听器即 resolve（不 await 子进程 close），
    // 此时文本可能仍在流式输出。状态保持 'prompting'，回落 'connected' 只由
    // 该轮 turn_end（AgentStreamEvent）或 error 事件驱动（见 onEvent / settle）。
    // 进程清退（无 turn_end）由 AgentSession 在 close 时兜底 emit turn_end。
  }

  /** 取消当前轮：调 session.cancel；状态回落 connected。 */
  cancelTurn(conversationId: number): void {
    const entry = this.contexts.get(conversationId);
    if (!entry) return;
    entry.activeSession?.cancel();
    entry.activeSession = null;
    if (entry.snapshot.status === 'prompting') {
      this.setStatus(entry, 'connected');
    }
  }

  /** 清理会话上下文，取消活跃轮，发 disconnected。 */
  disconnect(conversationId: number): void {
    const entry = this.contexts.get(conversationId);
    if (!entry) return;
    try {
      entry.activeSession?.cancel();
    } catch {
      // 容错
    }
    entry.activeSession = null;
    this.contexts.delete(conversationId);
    this.emitStatus(conversationId, 'disconnected');
  }

  disconnectAll(): void {
    for (const conversationId of Array.from(this.contexts.keys())) {
      this.disconnect(conversationId);
    }
  }

  /**
   * 设置审批策略。sendPrompt 起轮时以 live getter 透传给 pi-rpc，
   * 故运行时切换对活跃会话即时生效（confirm 门控读最新值）。
   */
  setPermissionPolicy(policy: string): void {
    this.permissionPolicy = policy;
  }

  /** 兼容旧 ipc：多协议首版无 modes，noop。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setMode(_conversationId: number, _modeId: string): Promise<void> {
    // TODO(A10+): 多协议暂不支持 mode 切换。
  }

  /** 兼容旧 ipc：多协议首版无 config options，noop。 */
  async setConfigOption(
    _conversationId: number,
    _configId: string,
    _valueId: string,
  ): Promise<void> {
    // TODO(A10+): 多协议暂不支持 config option。
  }

  /** 把用户对审批卡片的响应委派给该会话的活跃轮（pi-rpc 写回 extension_ui_response）。 */
  async respondPermission(
    conversationId: number,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    const entry = this.contexts.get(conversationId);
    entry?.activeSession?.respondPermission?.(requestId, optionId);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private setStatus(entry: RuntimeContextEntry, status: RuntimeStatus): void {
    entry.snapshot.status = status;
    this.emitStatus(entry.snapshot.conversationId, status);
  }

  private emitStatus(conversationId: number, status: RuntimeStatus): void {
    this.emit('status', { conversationId, status } satisfies RuntimeStatusPayload);
  }

  private getEntryOrThrow(conversationId: number): RuntimeContextEntry {
    const entry = this.contexts.get(conversationId);
    if (!entry) {
      throw new Error(`No active runtime for conversation ${conversationId}`);
    }
    return entry;
  }
}

// ─── 工具：contents 文本化为 prompt ──────────────────────────────────────────

/**
 * 把 sendPrompt 的 contents（ACP 风格 content block 数组）压成纯文本 prompt。
 * - { type: 'text', text } → text
 * - 字符串 → 原样
 * - 其他 → JSON 兜底
 */
function stringifyContents(contents: unknown[]): string {
  if (!Array.isArray(contents)) return String(contents ?? '');
  const parts: string[] = [];
  for (const item of contents) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        parts.push(obj.text);
        continue;
      }
      parts.push(JSON.stringify(obj));
      continue;
    }
    parts.push(String(item ?? ''));
  }
  return parts.join('\n');
}
