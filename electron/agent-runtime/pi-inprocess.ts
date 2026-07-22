/**
 * pi-inprocess.ts
 *
 * Pi 的「进程内 SDK」驱动 —— 取代旧的「vendored CLI 子进程 + JSON-RPC 解析」。
 *
 * 直接在 Electron 主进程里用 @earendil-works/pi-coding-agent 的 SDK 跑一轮 agent：
 *   1. 按 agentDir（=App 投影出的 ~/.lingji/pi-agent）解析 auth/models/settings。
 *   2. 解析 model（'provider/modelId'）/ thinkingLevel / 启用的 skills。
 *   3. resume：按 resumeSessionId 在 sessionDir 里找回历史会话文件并 open。
 *   4. 经 DefaultResourceLoader.extensionFactories 注入一个 inline 扩展，注册
 *      `tool_call` handler 做审批门控（pi 内置工具执行前 beforeToolCall → emitToolCall，
 *      handler 返回 {block:true} 即拦下）；createAgentSession → subscribe 把
 *      AgentSessionEvent 归一化为 AgentStreamEvent → onEvent。
 *   5. session.prompt() 跑一轮；abort / dispose / respondPermission 管理生命周期。
 *
 * 审批门控说明：pi 的内置工具（read/edit/write/bash）从不调用 `uiContext.confirm`
 * （confirm 仅给扩展用），故门控必须挂在 `tool_call` 扩展事件上。confirm 仍保留作
 * 防御性兜底（若某个自定义工具/扩展走 confirm 路径，同样经审批策略门控）。
 *
 * 注意：pi 包是 ESM-only（package.json exports 仅 `import` 条件），而 Electron 主
 * 进程构建为 CJS，故用 dynamic import() 惰性加载（Node 24 支持从 CJS import ESM）。
 */

import path from 'node:path';
import type { AgentStreamEvent } from './event-model';
import { classifyToolKind } from './event-model';
import { evaluateToolCallGate } from './pi-permission';
import {
  extractPiToolCallUpdate,
  PiToolEventRelay,
} from './pi-tool-events';
import type { ResolvedAgentSkill } from '../acp/types';
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const THINKING_LEVELS = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/** 惰性加载 ESM-only 的 pi SDK（CJS 主进程经 dynamic import 桥接）。 */
let sdkPromise: Promise<PiSdk> | null = null;
function loadPiSdk(): Promise<PiSdk> {
  if (!sdkPromise) {
    sdkPromise = import('@earendil-works/pi-coding-agent');
  }
  return sdkPromise;
}

export interface PiInProcessStartInput {
  prompt: string;
  cwd?: string;
  /** pi 配置目录（auth/models/settings/sessions 根）；缺省走 SDK 默认 ~/.pi/agent。 */
  agentDir?: string;
  /** 'default'（跟随配置）| 'provider/modelId'。 */
  model?: string;
  /** 'default'（跟随配置）| ThinkingLevel。 */
  reasoning?: string;
  /** 启用的内置 skills（rootPath 注入 resourceLoader）。 */
  skills?: ResolvedAgentSkill[];
  /** resume：要恢复的 pi 会话 id（externalId）。 */
  resumeSessionId?: string | null;
  /** 审批策略 getter（live）；confirm 门控时读最新值，缺省自动放行。 */
  getPermissionPolicy?: () => string;
  onEvent: (ev: AgentStreamEvent) => void;
}

/** 数字归一化（usage 字段容错）。 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 把工具入参序列化为审批卡片可读文本（容错循环引用 / 非 JSON）。 */
function safeJsonStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Soften "Command exited with code N" 误报。
 *
 * pi 的内置 bash 工具策略是「shell 退出码非 0 即抛错」（见 pi `dist/core/tools/bash.js`），
 * 抛出后 SDK 会把整次调用标记成 isError=true。但很多 POSIX 命令把非零退出当成
 * 「正常的否定结果」用：grep 无匹配 exit 1、diff 有差异 exit 1、test/[ 断言为假
 * exit 1。如果不修正，UI 会把这些「成功执行得出否定结论」的命令显示成「执行失败」，
 * 误导用户与下游 agent。
 *
 * 这里只软化「pi 自己在 result 文本里追加 'Command exited with code N'」这一种
 * 形态——其它 isError 通道（Command timed out / Command aborted / 工具实现抛
 * 异常）保留原 isError，不在此修正。
 *
 * 判定为软化（return false）的条件：
 *   - toolName 看起来是 bash 类
 *   - 文本结尾匹配 `Command exited with code (\d+)$`
 *   - 命令的「管道末段 head 词」属于已知白名单 + 该退出码在白名单允许集合里
 *
 * 入参 toolName/input/text 都允许 unknown，纯函数好测。
 */
export function softenBashError(
  toolName: unknown,
  input: unknown,
  text: unknown,
  isError: boolean,
): boolean {
  if (!isError) return false;
  const name = typeof toolName === 'string' ? toolName : '';
  // bash / shell / exec / run_command / terminal 之类的命令型工具
  if (!/^(bash|shell|exec|run|run_command|command|terminal)$/i.test(name)) return isError;
  const body = typeof text === 'string' ? text : '';
  const m = body.match(/Command exited with code (\d+)\s*$/);
  if (!m) return isError;
  const code = Number(m[1]);
  if (!Number.isFinite(code)) return isError;
  // 抽 command：优先 input.command，其次直接把 input 当字符串
  const rawInput = input as { command?: unknown } | string | null | undefined;
  let cmd = '';
  if (typeof rawInput === 'string') cmd = rawInput;
  else if (rawInput && typeof (rawInput as { command?: unknown }).command === 'string') {
    cmd = (rawInput as { command: string }).command;
  }
  if (!cmd) return isError;
  // 取管道最后一段命令的 head 词（忽略 env 赋值、前导空白）
  const tailSegment = cmd.split('|').pop()?.trim() ?? '';
  const firstToken = tailSegment.split(/\s+/).find((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t)) ?? '';
  // /usr/bin/grep → grep；rg.exe → rg
  const head = firstToken
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase();
  if (!head) return isError;
  // 白名单：把「非 0 退出表达否定结论」的命令明确列出，code 必须命中允许集合
  const SOFT_NONZERO: Record<string, number[]> = {
    grep: [1],
    egrep: [1],
    fgrep: [1],
    rg: [1],
    ag: [1],
    diff: [1],
    cmp: [1],
  };
  if (SOFT_NONZERO[head]?.includes(code)) return false;
  // test / [ ：任何非 0 都是「断言为假」
  if (head === 'test' || head === '[') return false;
  return isError;
}

/** 把 tool_execution_end 的 result（任意形状）抽成文本：content[] → output → JSON。 */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  const r = result as { content?: unknown; output?: unknown } | null | undefined;
  if (r && Array.isArray(r.content)) {
    return r.content
      .map((c) => {
        const item = c as { type?: unknown; text?: unknown };
        return item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(c);
      })
      .join('\n');
  }
  if (r && typeof r.output === 'string') return r.output;
  return JSON.stringify(result ?? null);
}

/** 从一条 AgentMessage 抽 usage（input/output tokens）。 */
function extractUsage(message: unknown): AgentStreamEvent | null {
  const usage = (message as { usage?: { input?: unknown; output?: unknown } } | undefined)?.usage;
  if (!usage) return null;
  const inputTokens = num(usage.input);
  const outputTokens = num(usage.output);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return { type: 'usage', inputTokens, outputTokens };
}

export function extractFinalAssistantError(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as
      | { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
      | undefined;
    if (message?.role !== 'assistant') continue;
    const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage.trim() : '';
    if (errorMessage) return errorMessage;
    if (message.stopReason === 'error') return 'pi agent returned an error without details';
    return null;
  }
  return null;
}

/**
 * 进程内 pi 会话。生命周期：start → (事件流) → agent_end/turn_end 终态；
 * 期间可 respondPermission；外部 cancel 时 abort + dispose。
 */
export class PiInProcessSession {
  private session: PiAgentSession | null = null;
  private disposed = false;
  private permSeq = 0;
  private readonly pendingPermissions = new Map<string, (allow: boolean) => void>();
  private lastToolName: string | undefined;
  private lastToolInput: unknown;
  private cwd: string | undefined;
  private getPermissionPolicy: (() => string) | undefined;
  private onEvent: (ev: AgentStreamEvent) => void = () => {};
  private toolEvents: PiToolEventRelay | null = null;

  async start(input: PiInProcessStartInput): Promise<void> {
    const cwd = input.cwd ?? process.cwd();
    this.cwd = cwd;
    this.getPermissionPolicy = input.getPermissionPolicy;
    this.onEvent = input.onEvent;
    this.toolEvents = new PiToolEventRelay(this.cwd, this.onEvent);

    const sdk = await loadPiSdk();
    const agentDir = input.agentDir;

    // 复刻子进程时代的 env 契约：把 agentDir 写到 PI_CODING_AGENT_DIR，使 SDK 内部
    // getAgentDir()（决定 sessions 目录等默认路径）与 App 投影的配置目录一致。
    if (agentDir) {
      process.env.PI_CODING_AGENT_DIR = agentDir;
    }

    // 1) sessionManager：resume → open 历史会话；否则新建。sessionDir 省略，
    //    由 SDK 按 PI_CODING_AGENT_DIR 解析默认 sessions 目录。
    let sessionManager;
    if (input.resumeSessionId) {
      try {
        const list = await sdk.SessionManager.list(cwd);
        const match = list.find((s) => s.id === input.resumeSessionId);
        sessionManager = match
          ? sdk.SessionManager.open(match.path)
          : sdk.SessionManager.create(cwd);
      } catch {
        sessionManager = sdk.SessionManager.create(cwd);
      }
    } else {
      sessionManager = sdk.SessionManager.create(cwd);
    }

    // 2) auth + models（读 agentDir 下 App 投影出的 auth.json / models.json）。
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: agentDir ? path.join(agentDir, 'auth.json') : undefined,
      modelsPath: agentDir ? path.join(agentDir, 'models.json') : undefined,
      allowModelNetwork: false,
    });

    // 3) model 解析：'provider/modelId' → Model；'default' / 解析失败 → 跟随配置。
    let model;
    if (input.model && input.model !== 'default') {
      const slash = input.model.indexOf('/');
      if (slash > 0) {
        const provider = input.model.slice(0, slash);
        const modelId = input.model.slice(slash + 1);
        model = modelRuntime.getModel(provider, modelId);
      }
    }

    // 4) thinkingLevel：'default' / 非法 → undefined（跟随配置）。
    const thinkingLevel =
      input.reasoning && THINKING_LEVELS.has(input.reasoning as PiThinkingLevel)
        ? (input.reasoning as PiThinkingLevel)
        : undefined;

    // 5) skills + 审批门控扩展：
    //    skills 走 additionalSkillPaths；审批门控走 extensionFactories（inline 扩展
    //    注册 tool_call handler）。后者要求始终构造 DefaultResourceLoader——即使没有
    //    skills，也要把审批扩展挂上，否则 pi 内置工具会无门控直接执行。
    const skillPaths = (input.skills ?? [])
      .filter((s) => s.enabled && s.status === 'available')
      .map((s) => s.rootPath);
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: agentDir ?? sdk.getAgentDir(),
      settingsManager,
      additionalSkillPaths: skillPaths,
      extensionFactories: [this.buildApprovalExtensionFactory()],
    });
    await resourceLoader.reload();

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader,
      model,
      thinkingLevel,
    });
    if (this.disposed) {
      // start 期间被 cancel：立刻收尾。
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
      return;
    }
    this.session = session;

    // 注入 confirm 门控（审批卡片落点）。
    await session.bindExtensions({ uiContext: this.buildUiContext() });

    // 上报 sessionId（externalId 持久化），让后续轮可 resume。
    this.onEvent({ type: 'status', label: 'session', sessionId: session.sessionId });

    // 订阅事件流 → 归一化。
    session.subscribe((ev) => this.handleEvent(ev));

    // 跑一轮：不 await，让事件驱动终态回落；prompt() 异常归一化为 error。
    void session.prompt(input.prompt).catch((err: unknown) => {
      if (this.disposed) return;
      this.onEvent({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** 响应一次挂起审批：optionId !== 'reject' 视为允许。 */
  respondPermission(requestId: string, optionId: string): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    resolve(optionId !== 'reject');
  }

  /** 优雅停止当前轮。 */
  abort(): void {
    try {
      void this.session?.abort();
    } catch {
      /* ignore */
    }
  }

  /** 清理：拒绝挂起审批、dispose 会话。 */
  dispose(): void {
    this.disposed = true;
    for (const resolve of this.pendingPermissions.values()) {
      try {
        resolve(false);
      } catch {
        /* ignore */
      }
    }
    this.pendingPermissions.clear();
    this.toolEvents?.clear();
    this.toolEvents = null;
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
  }

  // ── 事件归一化 ───────────────────────────────────────────────────────────────

  private handleEvent(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case 'message_update':
        this.handleMessageUpdate(ev);
        break;

      case 'tool_execution_start':
        this.handleToolExecutionStart(ev);
        break;

      case 'tool_execution_end':
        this.handleToolExecutionEnd(ev);
        break;

      case 'turn_end': {
        // 每个 agent 轮结束：只上报 usage，不作为终态（终态见 agent_end）。
        const usage = extractUsage(ev.message);
        if (usage) this.onEvent(usage);
        break;
      }

      case 'agent_end': {
        // 整轮 prompt 结束。willRetry=true 表示将自动重试，尚未终态。
        if (!ev.willRetry) {
          const errorMessage = extractFinalAssistantError(ev.messages);
          if (errorMessage) {
            this.onEvent({ type: 'error', message: errorMessage });
            break;
          }
          this.onEvent({ type: 'turn_end' });
        }
        break;
      }

      default:
        break;
    }
  }

  private handleMessageUpdate(
    ev: Extract<AgentSessionEvent, { type: 'message_update' }>,
  ): void {
    const event = ev.assistantMessageEvent;
    switch (event.type) {
      case 'text_delta':
        this.onEvent({ type: 'text_delta', delta: event.delta });
        break;
      case 'thinking_start':
        this.onEvent({ type: 'thinking_start' });
        break;
      case 'thinking_delta':
        this.onEvent({ type: 'thinking_delta', delta: event.delta });
        break;
      case 'thinking_end':
        this.onEvent({ type: 'thinking_end' });
        break;
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end': {
        const update = extractPiToolCallUpdate(event);
        if (update) this.getToolEvents().observe(update);
        break;
      }
      case 'error':
        this.onEvent({
          type: 'error',
          message: event.error?.errorMessage || event.reason || 'unknown error',
        });
        break;
      default:
        break;
    }
  }

  private handleToolExecutionStart(
    ev: Extract<AgentSessionEvent, { type: 'tool_execution_start' }>,
  ): void {
    this.lastToolName = ev.toolName;
    this.lastToolInput = ev.args;
    this.getToolEvents().observe(
      {
        id: ev.toolCallId,
        name: ev.toolName,
        input: ev.args ?? null,
      },
      { captureSnapshot: true },
    );
  }

  private handleToolExecutionEnd(
    ev: Extract<AgentSessionEvent, { type: 'tool_execution_end' }>,
  ): void {
    const content = stringifyToolResult(ev.result);
    const toolInput = this.getToolEvents().getInput(ev.toolCallId) ?? this.lastToolInput;
    // Pi treats every non-zero bash exit as an error; keep boolean-style commands readable.
    const isError = softenBashError(ev.toolName, toolInput, content, ev.isError);
    this.getToolEvents().complete({
      toolCallId: ev.toolCallId,
      toolName: ev.toolName,
      content,
      isError,
    });
  }

  private getToolEvents(): PiToolEventRelay {
    if (!this.toolEvents) {
      this.toolEvents = new PiToolEventRelay(this.cwd, this.onEvent);
    }
    return this.toolEvents;
  }

  // ── 审批门控 ─────────────────────────────────────────────────────────────────

  /**
   * surface 一张审批卡片并等待用户响应。resolve(true)=允许、resolve(false)=拒绝。
   * 由 tool_call handler（主路径）与 confirm（防御兜底）共用。
   */
  private requestApproval(title: string, rawInput: string, toolName?: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = `perm-${++this.permSeq}`;
      this.pendingPermissions.set(requestId, resolve);
      this.onEvent({
        type: 'permission_request',
        requestId,
        toolCall: {
          title: title || toolName || '需要确认操作',
          rawInput: rawInput || '',
          kind: classifyToolKind(toolName ?? ''),
        },
        options: [
          { optionId: 'allow_once', name: '仅此次允许', kind: 'allow_once' },
          { optionId: 'allow_always', name: '本轮始终允许', kind: 'allow_always' },
          { optionId: 'reject', name: '拒绝', kind: 'reject_always' },
        ],
      });
    });
  }

  /**
   * 构造审批门控扩展（inline ExtensionFactory）：注册 pi 的 `tool_call` 事件 handler。
   *
   * pi 在执行任何工具前触发 beforeToolCall → emitToolCall('tool_call')，handler 返回
   * { block:true } 即拦下工具。这是 pi 内置工具（read/edit/write/bash）唯一的门控点——
   * 它们从不调用 uiContext.confirm。按当前审批策略：auto_allow 直接放行；ask 则 surface
   * 审批卡片等用户响应，拒绝时 block。
   */
  private buildApprovalExtensionFactory(): ExtensionFactory {
    return (pi) => {
      pi.on('tool_call', async (event: ToolCallEvent) => {
        const policy = this.getPermissionPolicy?.();
        const decision = evaluateToolCallGate(policy, {
          toolName: event.toolName,
          input: event.input,
          cwd: this.cwd,
        });
        if (decision === 'auto_allow') return undefined;
        const allowed = await this.requestApproval(
          event.toolName,
          safeJsonStringify(event.input),
          event.toolName,
        );
        return allowed ? undefined : { block: true, reason: '用户拒绝了该操作' };
      });
    };
  }

  // ── headless uiContext ───────────────────────────────────────────────────────

  /**
   * 构造一个 headless 的 ExtensionUIContext：confirm 作防御性审批兜底（内置工具不会
   * 走它，但自定义工具/扩展若调 confirm 同样经审批策略门控），select 取首项、
   * input/editor 返回空，其余 TUI 方法 no-op。
   */
  private buildUiContext(): ExtensionUIContext {
    const confirm = async (title: string, message: string): Promise<boolean> => {
      const policy = this.getPermissionPolicy?.();
      const decision = evaluateToolCallGate(policy, {
        toolName: this.lastToolName,
        // confirm 没有结构化 input；用 message 文案 + 最近工具入参兜底分类。
        input: message || this.lastToolInput,
        cwd: this.cwd,
      });
      if (decision === 'auto_allow') return true;
      return this.requestApproval(title, message, this.lastToolName);
    };

    const noop = (): void => {};
    const headless = {
      confirm,
      select: async (_title: string, options: string[]) => options[0],
      input: async () => undefined,
      notify: noop,
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      custom: async () => undefined,
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => '',
      editor: async () => undefined,
      addAutocompleteProvider: noop,
      setEditor: noop,
    };
    // headless 适配器：只实现 agent 实际会调用的方法，其余 TUI 接口 no-op。
    return headless as unknown as ExtensionUIContext;
  }
}
