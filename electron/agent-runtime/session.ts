/**
 * session.ts
 *
 * AgentSession —— Agent Runtime 的会话执行核心（in-process pi SDK）。
 *
 * 职责：
 *   1. 从 start 入参（含 env.PI_CODING_AGENT_DIR）解析 agentDir。
 *   2. 委派 PiInProcessSession（直接用 pi SDK 跑一轮，无子进程）。
 *   3. 透传归一化事件 AgentStreamEvent → onEvent，并兜底终态。
 *   4. 管理生命周期（cancel / respondPermission）。
 *
 * driver 可注入（AgentSessionDeps.createDriver），便于单测不依赖真实 SDK。
 *
 * 历史：旧实现是 spawn vendored CLI（resources/pi/dist/cli.js）+ JSON-RPC 解析；
 * 已切换为进程内 SDK，子进程 / pi-rpc parser / bundled-runtime 全部移除。
 */

import type { RuntimeAgentDef } from './types';
import type { AgentStreamEvent } from './event-model';
import type { ResolvedAgentSkill } from '../acp/types';
import { PiInProcessSession, type PiInProcessStartInput } from './pi-inprocess';

// ─── 公开接口 ────────────────────────────────────────────────────────────────

/** in-process driver 的最小契约（便于测试注入 fake）。 */
export interface PiDriverLike {
  start(input: PiInProcessStartInput): Promise<void>;
  respondPermission(requestId: string, optionId: string): void;
  abort(): void;
  dispose(): void;
}

export interface AgentSessionDeps {
  /** 可注入 driver 工厂；默认 () => new PiInProcessSession()。 */
  createDriver?: () => PiDriverLike;
}

export interface AgentSessionStartInput {
  def: RuntimeAgentDef;
  prompt: string;
  cwd?: string;
  model?: string;
  /** 思考程度（reasoning effort）。 */
  reasoning?: string;
  /** 额外环境变量；其中 PI_CODING_AGENT_DIR 用作 pi 配置目录（agentDir）。 */
  env?: Record<string, string>;
  /** resume 已存在会话（pi 会话 externalId）。 */
  resumeSessionId?: string | null;
  isResuming?: boolean;
  /** 连接期解析出的启用 skills。 */
  skills?: ResolvedAgentSkill[];
  /** 审批策略 getter（live）；透传给 driver 做 confirm 门控。 */
  getPermissionPolicy?: () => string;
  onEvent: (ev: AgentStreamEvent) => void;
}

// ─── AgentSession ──────────────────────────────────────────────────────────

export class AgentSession {
  private readonly createDriver: () => PiDriverLike;
  private driver: PiDriverLike | null = null;
  private terminalEmitted = false;
  private cancelled = false;

  constructor(deps?: AgentSessionDeps) {
    this.createDriver = deps?.createDriver ?? (() => new PiInProcessSession());
  }

  async start(input: AgentSessionStartInput): Promise<void> {
    // 包裹 onEvent：标记 terminalEmitted，避免重复终态。
    const onEvent = (ev: AgentStreamEvent) => {
      if (this.cancelled) return;
      if (ev.type === 'turn_end' || ev.type === 'error') {
        if (this.terminalEmitted) return;
        this.terminalEmitted = true;
      }
      input.onEvent(ev);
    };

    const agentDir = input.env?.PI_CODING_AGENT_DIR;
    const driver = this.createDriver();
    this.driver = driver;

    try {
      await driver.start({
        prompt: input.prompt,
        cwd: input.cwd,
        agentDir,
        model: input.model ?? input.def.defaultModel,
        reasoning: input.reasoning ?? input.def.defaultReasoning,
        skills: input.skills,
        resumeSessionId: input.resumeSessionId,
        getPermissionPolicy: input.getPermissionPolicy,
        onEvent,
      });
    } catch (err) {
      // start() 抛错 → error 终态。直接走原始 onEvent（绕开 wrapper 的终态去重，
      // 此处自行置 terminalEmitted），避免被 wrapper 二次抑制。
      if (!this.terminalEmitted && !this.cancelled) {
        this.terminalEmitted = true;
        input.onEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 响应一次挂起的审批请求（委派给 driver）。 */
  respondPermission(requestId: string, optionId: string): void {
    this.driver?.respondPermission(requestId, optionId);
  }

  /** 取消会话：abort 当前轮 + dispose 清理。 */
  cancel(): void {
    this.cancelled = true;
    try {
      this.driver?.abort();
    } catch {
      /* ignore */
    }
    try {
      this.driver?.dispose();
    } catch {
      /* ignore */
    }
    this.driver = null;
  }
}
