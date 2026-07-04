/**
 * pi-headless.ts
 *
 * 面向"确定性编排器"的进程内 pi 无头会话：给一个角色（独立 system prompt + 工具
 * 白名单 + 路径守卫）开一个隔离上下文，多轮 prompt、拿最终文本，全程无 UI、无审批
 * 卡片、无会话文件落盘（SessionManager.inMemory）。
 *
 * 与 PiInProcessSession（ChatPane 交互会话）的区别：
 * - 不接事件流 UI，text_delta 只在内部累积成本轮回复文本；
 * - 工具面由 createAgentSession 的 tools 白名单 + tool_call 守卫扩展双重钳制
 *   （bash 一律 block；write/edit 目标必须落在 writeWithinDir 内）；
 * - 共用同一 PI_CONFIG_DIR（~/.lingji/pi-agent）：auth/models/settings 由
 *   ensurePiHeadlessConfig 从 App AISettings 投影，与 ChatPane 会话方向一致。
 */

import path from 'node:path';
import os from 'node:os';
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { writePiConfig } from './pi-config-seed';
import { stringifyToolResult } from './pi-inprocess';
import { loadFullHeadlessAISettings } from '../pipeline/headless-settings';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

let sdkPromise: Promise<PiSdk> | null = null;
function loadPiSdk(): Promise<PiSdk> {
  if (!sdkPromise) sdkPromise = import('@earendil-works/pi-coding-agent');
  return sdkPromise;
}

/** 与 electron/acp/ipc.ts 的 PI_CONFIG_DIR 同值（不引入 electron app 依赖，便于测试）。 */
export function getPiConfigDir(): string {
  return path.join(os.homedir(), '.lingji', 'pi-agent');
}

/** 把 App AISettings 投影写入 pi 配置目录（幂等，每次编排前调用即可）。 */
export async function ensurePiHeadlessConfig(userDataPath: string): Promise<string> {
  const dir = getPiConfigDir();
  const ai = await loadFullHeadlessAISettings(userDataPath);
  await writePiConfig(dir, ai);
  return dir;
}

/** 无头会话的观测事件（供编排器转发到 UI 观测面板；不影响 prompt() 返回契约）。 */
export type PiHeadlessStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name?: string; content: string; isError: boolean };

export interface PiHeadlessCreateInput {
  /** 角色 system prompt（覆盖 pi 默认系统提示）。 */
  systemPrompt: string;
  /** 内置工具白名单；空数组 = 纯文本角色（noTools）。 */
  tools: string[];
  cwd: string;
  /** pi 配置目录；缺省 getPiConfigDir()。 */
  agentDir?: string;
  /** write/edit 目标路径必须落在此目录内，越界即 block。 */
  writeWithinDir?: string;
  signal?: AbortSignal;
  /** 会话级模型覆盖：'provider/modelId'；缺省（含 'default'/解析失败）跟随 settings.json 默认。 */
  model?: string;
  /** 观测事件回调（流式文本/思考/工具调用）；缺省不转发。 */
  onEvent?: (ev: PiHeadlessStreamEvent) => void;
}

/** 守卫扩展：bash 类一律拦截；write/edit 限定目录。纯函数便于测试。 */
export function evaluateHeadlessToolGate(
  toolName: unknown,
  input: unknown,
  opts: { cwd: string; writeWithinDir?: string },
): { block: true; reason: string } | undefined {
  const name = typeof toolName === 'string' ? toolName : '';
  if (/^(bash|shell|exec|run|run_command|command|terminal)$/i.test(name)) {
    return { block: true, reason: 'headless 角色禁止执行命令' };
  }
  if (!/^(write|edit)$/i.test(name)) return undefined;
  const within = opts.writeWithinDir;
  if (!within) return { block: true, reason: '该角色未开放文件写入' };
  const raw = input as { path?: unknown; file_path?: unknown; filePath?: unknown } | null | undefined;
  const target = [raw?.path, raw?.file_path, raw?.filePath].find((v) => typeof v === 'string') as
    | string
    | undefined;
  if (!target) return { block: true, reason: '写入目标缺失' };
  const resolved = path.resolve(opts.cwd, target);
  const root = path.resolve(within) + path.sep;
  if (resolved !== path.resolve(within) && !resolved.startsWith(root)) {
    return { block: true, reason: `写入目标越界: ${target}` };
  }
  return undefined;
}

/**
 * 无头 pi 角色会话：create → prompt()×N → dispose。
 * prompt 返回该轮 assistant 的完整文本（text_delta 累积）。
 */
export class PiHeadlessSession {
  private session: PiAgentSession | null = null;
  private buffer = '';
  private lastError: string | null = null;
  private onAbort: (() => void) | null = null;
  private onStreamEvent: ((ev: PiHeadlessStreamEvent) => void) | undefined;

  static async create(input: PiHeadlessCreateInput): Promise<PiHeadlessSession> {
    const sdk = await loadPiSdk();
    const inst = new PiHeadlessSession();
    inst.onStreamEvent = input.onEvent;
    const agentDir = input.agentDir ?? getPiConfigDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const modelRegistry = sdk.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
    // 会话级模型覆盖：'provider/modelId' → Model；'default'/解析失败 → undefined（跟随配置）。
    let model;
    if (input.model && input.model !== 'default') {
      const slash = input.model.indexOf('/');
      if (slash > 0) {
        model = modelRegistry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
      }
    }
    const settingsManager = sdk.SettingsManager.create(input.cwd, agentDir);
    const guard: ExtensionFactory = (pi) => {
      pi.on('tool_call', async (event: ToolCallEvent) => {
        return evaluateHeadlessToolGate(event.toolName, event.input, {
          cwd: input.cwd,
          writeWithinDir: input.writeWithinDir,
        });
      });
    };
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      systemPrompt: input.systemPrompt,
      noSkills: true,
      extensionFactories: [guard],
    });
    await resourceLoader.reload();

    const { session } = await sdk.createAgentSession({
      cwd: input.cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(input.cwd),
      model,
      ...(input.tools.length > 0 ? { tools: input.tools } : { noTools: 'all' as const }),
    });
    inst.session = session;
    await session.bindExtensions({ uiContext: inst.buildUiContext() });
    session.subscribe((ev) => inst.handleEvent(ev));
    if (input.signal) {
      const onAbort = () => inst.abort();
      input.signal.addEventListener('abort', onAbort, { once: true });
      inst.onAbort = () => input.signal?.removeEventListener('abort', onAbort);
    }
    return inst;
  }

  /** 跑一轮并返回本轮 assistant 文本；模型/流式错误抛出。 */
  async prompt(text: string): Promise<string> {
    if (!this.session) throw new Error('会话已释放');
    this.buffer = '';
    this.lastError = null;
    await this.session.prompt(text);
    if (this.lastError) throw new Error(this.lastError);
    return this.buffer.trim();
  }

  abort(): void {
    try {
      void this.session?.abort();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.onAbort?.();
    this.onAbort = null;
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
  }

  private handleEvent(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case 'message_update': {
        const a = ev.assistantMessageEvent;
        if (a.type === 'text_delta') {
          this.buffer += a.delta;
          this.onStreamEvent?.({ type: 'text_delta', delta: a.delta });
        } else if (a.type === 'thinking_delta') {
          this.onStreamEvent?.({ type: 'thinking_delta', delta: a.delta });
        } else if (a.type === 'error') {
          this.lastError = a.error?.errorMessage || a.reason || 'pi 角色会话出错';
        }
        break;
      }
      case 'tool_execution_start':
        this.onStreamEvent?.({
          type: 'tool_use',
          id: ev.toolCallId,
          name: ev.toolName,
          input: ev.args ?? null,
        });
        break;
      case 'tool_execution_end':
        this.onStreamEvent?.({
          type: 'tool_result',
          toolUseId: ev.toolCallId,
          name: ev.toolName,
          content: stringifyToolResult(ev.result),
          isError: ev.isError,
        });
        break;
      default:
        break;
    }
  }

  /** 全自动 headless uiContext：confirm 恒放行（工具面已由白名单+守卫钳制）。 */
  private buildUiContext(): ExtensionUIContext {
    const noop = (): void => {};
    const headless = {
      confirm: async () => true,
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
    return headless as unknown as ExtensionUIContext;
  }
}
