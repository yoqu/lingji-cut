export interface AgentModel {
  id: string;
  label: string;
}

export interface RuntimeAgentDef {
  id: string; // 'pi'
  name: string;
  bin: string;
  /**
   * 进程内 agent：直接在主进程用 SDK 跑（无子进程 / 无需安装探测）。
   * pi 已切换为 in-process（@earendil-works/pi-coding-agent SDK），preflight 视其恒可用。
   */
  inProcess?: boolean;
  versionArgs: string[];
  env?: Record<string, string>;
  defaultModel?: string;
  /** Static model list for UI selectors (settings + composer chip). */
  models?: AgentModel[];

  /** 思考程度可选项（UI 切换用）；为空表示该 agent 不支持思考程度切换。 */
  reasoningOptions?: AgentModel[];
  /** 默认思考程度 id（一般为 'default'）。 */
  defaultReasoning?: string;
}
