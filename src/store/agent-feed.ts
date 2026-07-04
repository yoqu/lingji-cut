/**
 * agent-feed store — AI 卡片多 agent 生成过程的观测流（渲染端）。
 *
 * 订阅主进程 `agent-feed:event`（见 electron/pipeline/agent-feed.ts），把导演/雕刻/
 * 审查各角色的流式文本、工具调用与编排里程碑还原成 ConversationTurn[]，供观测面板
 * 复用 agent 对话组件（renderBlocks）直接渲染。
 *
 * 会话生命周期独立于统一进度任务：任务从进度条消失后记录仍可回看，
 * 直到手动清除或切换项目（clearAll）。内存上限：会话数 / turn 数 / 单块字符数三重截断。
 */

import { create } from 'zustand';
import type { AgentFeedEvent, AgentFeedRole, AgentFeedStage } from '../../electron/pipeline/agent-feed';
import type { ConversationBlock, ConversationTurn } from '../types/conversation';

export type { AgentFeedEvent, AgentFeedRole, AgentFeedStage };

export type StageStatus = 'pending' | 'active' | 'done' | 'error';

export interface StageState {
  status: StageStatus;
  /** 该阶段最近一次重试轮次（分镜重出 / 修复 / 回炉）。 */
  round?: number;
}

export const STAGE_ORDER: readonly AgentFeedStage[] = ['director', 'sculpt', 'mechqa', 'review'];
export const STAGE_NAMES: Record<AgentFeedStage, string> = {
  director: '导演',
  sculpt: '雕刻',
  mechqa: '质检',
  review: '审查',
};

function initialStages(): Record<AgentFeedStage, StageState> {
  return {
    director: { status: 'pending' },
    sculpt: { status: 'pending' },
    mechqa: { status: 'pending' },
    review: { status: 'pending' },
  };
}

export interface AgentFeedSession {
  /** `${feedId}::${cardKey}` */
  key: string;
  feedId: string;
  cardKey: string;
  label: string;
  turns: ConversationTurn[];
  status: 'active' | 'done' | 'error';
  startedAt: number;
  updatedAt: number;
  lastSeq: number;
  /** 阶段管线状态（由带 stage 的 phase 事件驱动）。 */
  stages: Record<AgentFeedStage, StageState>;
  currentStage?: AgentFeedStage;
  /** 角色 → 模型引用（providerId/modelId），来自事件 model 字段。 */
  modelsByRole: Partial<Record<AgentFeedRole, string>>;
  /** turn.id → 创建该 turn 时所处阶段（管线节点点击跳转用）。 */
  turnStages: Record<string, AgentFeedStage>;
}

export const MAX_SESSIONS = 50;
export const MAX_TURNS_PER_SESSION = 120;
export const MAX_BLOCK_TEXT = 20_000;

const ROLE_NAMES: Record<string, string> = {
  director: '导演',
  sculptor: '雕刻',
  reviewer: '审查',
  orchestrator: '编排',
};

export function roleDisplayName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

export function sessionKeyOf(ev: Pick<AgentFeedEvent, 'feedId' | 'cardKey'>): string {
  return `${ev.feedId}::${ev.cardKey}`;
}

/** 追加文本并截断留尾（超限时保留最新内容）。 */
function appendClipped(base: string, extra: string): string {
  const next = base + extra;
  if (next.length <= MAX_BLOCK_TEXT) return next;
  return `…${next.slice(next.length - MAX_BLOCK_TEXT)}`;
}

/**
 * 纯 reducer：把一条观测事件并入会话（不存在则新建）。
 * - 乱序防御：seq 不大于 lastSeq 的事件丢弃；
 * - 角色切换开新 assistant turn（agentId=role, agentName=中文角色名）；
 * - text/thinking 合并进末尾同类块；tool_use/tool_result 按 toolCallId 配对；
 * - phase/milestone 落为编排 turn 的文本行；error/done 收尾会话状态。
 */
export function reduceFeedEvent(
  prev: AgentFeedSession | null,
  ev: AgentFeedEvent,
): AgentFeedSession | null {
  if (prev && ev.seq <= prev.lastSeq) return prev;

  const base: AgentFeedSession = prev ?? {
    key: sessionKeyOf(ev),
    feedId: ev.feedId,
    cardKey: ev.cardKey,
    label: ev.cardLabel?.trim() || ev.cardKey,
    turns: [],
    status: 'active',
    startedAt: ev.ts,
    updatedAt: ev.ts,
    lastSeq: 0,
    stages: initialStages(),
    modelsByRole: {},
    turnStages: {},
  };

  // ── 阶段管线 / 模型表推导（在 turn 归并之前，让新 turn 拿到最新阶段）──
  let stages = base.stages;
  let currentStage = base.currentStage;
  let modelsByRole = base.modelsByRole;
  let turnStages = base.turnStages;

  if (ev.model && modelsByRole[ev.role] !== ev.model) {
    modelsByRole = { ...modelsByRole, [ev.role]: ev.model };
  }
  if (ev.kind === 'phase' && ev.stage) {
    const target = STAGE_ORDER.indexOf(ev.stage);
    const next = { ...stages };
    STAGE_ORDER.forEach((s, i) => {
      if (i < target) {
        if (next[s].status !== 'done') next[s] = { ...next[s], status: 'done' };
      } else if (i === target) {
        next[s] = { status: 'active', round: ev.round };
      } else if (next[s].status !== 'pending') {
        // 回炉等回跳：下游阶段回退待办，如实反映重走
        next[s] = { status: 'pending' };
      }
    });
    stages = next;
    currentStage = ev.stage;
  } else if (ev.kind === 'done') {
    const next = { ...stages };
    for (const s of STAGE_ORDER) {
      if (next[s].status === 'active') next[s] = { ...next[s], status: 'done' };
    }
    stages = next;
  } else if (ev.kind === 'error') {
    if (currentStage && stages[currentStage].status === 'active') {
      stages = { ...stages, [currentStage]: { ...stages[currentStage], status: 'error' } };
    }
  }

  const turns = base.turns.slice();

  // 取当前角色 turn；角色切换或空列表则开新 turn。
  let turn = turns[turns.length - 1];
  if (!turn || turn.agentId !== ev.role) {
    turn = {
      id: `${base.key}#${base.lastSeq}-${turns.length}`,
      conversationId: 0,
      role: 'assistant',
      blocks: [],
      createdAt: new Date(ev.ts).toISOString(),
      agentId: ev.role,
      agentName: roleDisplayName(ev.role),
    };
    if (currentStage) turnStages = { ...turnStages, [String(turn.id)]: currentStage };
    turns.push(turn);
  } else {
    turn = { ...turn, blocks: turn.blocks.slice() };
    turns[turns.length - 1] = turn;
  }
  const blocks = turn.blocks;
  const last = blocks[blocks.length - 1];

  let status = base.status;
  switch (ev.kind) {
    case 'text': {
      if (last?.type === 'text') {
        blocks[blocks.length - 1] = { type: 'text', text: appendClipped(last.text, ev.text ?? '') };
      } else {
        blocks.push({ type: 'text', text: ev.text ?? '' });
      }
      break;
    }
    case 'thinking': {
      if (last?.type === 'thinking') {
        blocks[blocks.length - 1] = {
          type: 'thinking',
          text: appendClipped(last.text, ev.text ?? ''),
        };
      } else {
        blocks.push({ type: 'thinking', text: ev.text ?? '' });
      }
      break;
    }
    case 'tool_use': {
      blocks.push({
        type: 'tool_call',
        toolCallId: ev.toolCallId ?? `tool-${ev.seq}`,
        title: ev.toolName ?? '工具调用',
        kind: ev.toolName ?? '',
        status: 'running',
        rawInput: ev.toolInput,
      });
      break;
    }
    case 'tool_result': {
      // 从尾部找到配对的 tool_call（同一角色 turn 内；跨 turn 场景极少，不深追）。
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const b = blocks[i];
        if (b.type === 'tool_call' && b.toolCallId === ev.toolCallId) {
          blocks[i] = {
            ...b,
            status: ev.isError ? 'failed' : 'completed',
            rawOutput: ev.toolOutput,
          };
          break;
        }
      }
      break;
    }
    case 'phase':
      blocks.push({ type: 'text', text: `▸ ${ev.text ?? ''}` });
      break;
    case 'milestone':
      blocks.push({ type: 'text', text: `⚑ ${ev.text ?? ''}` });
      break;
    case 'error':
      blocks.push({ type: 'error', message: ev.text ?? '生成失败' });
      status = 'error';
      break;
    case 'done':
      blocks.push({ type: 'text', text: `✓ ${ev.text ?? '完成'}` });
      status = 'done';
      break;
    default:
      break;
  }

  // turn 数上限：丢最旧的（观测价值在最新进展）。
  if (turns.length > MAX_TURNS_PER_SESSION) {
    const removed = turns.splice(0, turns.length - MAX_TURNS_PER_SESSION);
    if (removed.some((t) => turnStages[String(t.id)] !== undefined)) {
      turnStages = { ...turnStages };
      for (const t of removed) delete turnStages[String(t.id)];
    }
  }

  return {
    ...base,
    turns,
    status,
    updatedAt: ev.ts,
    lastSeq: ev.seq,
    stages,
    currentStage,
    modelsByRole,
    turnStages,
  };
}

/** 该 feedId 下的会话（按开始时间排序），供任务行入口与面板左栏。 */
export function sessionsForFeed(
  sessions: Map<string, AgentFeedSession>,
  feedId: string,
): AgentFeedSession[] {
  const out: AgentFeedSession[] = [];
  for (const s of sessions.values()) {
    if (s.feedId === feedId) out.push(s);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

interface AgentFeedStore {
  sessions: Map<string, AgentFeedSession>;
  panelOpen: boolean;
  selectedKey: string | null;
  /** 是否有进行中的会话（状态栏观测图标显隐）。 */
  hasActive: boolean;
  /** 编辑器右侧观测视图是否在场（在场时 openPanel 路由到 Inspector 而非浮层）。 */
  dockMounted: boolean;
  /** 单调计数：每次 +1 表示"请编辑器把 Inspector 切到观测视图"。 */
  focusToken: number;

  applyEvent: (ev: AgentFeedEvent) => void;
  /** 打开观测：编辑器在场切右侧 Inspector，否则弹状态栏浮层；给 feedId 时选中该任务最近更新的会话。 */
  openPanel: (feedId?: string) => void;
  closePanel: () => void;
  selectSession: (key: string) => void;
  setDockMounted: (mounted: boolean) => void;
  clearAll: () => void;
}

function deriveHasActive(sessions: Map<string, AgentFeedSession>): boolean {
  for (const s of sessions.values()) {
    if (s.status === 'active') return true;
  }
  return false;
}

export const useAgentFeedStore = create<AgentFeedStore>((set, get) => ({
  sessions: new Map(),
  panelOpen: false,
  selectedKey: null,
  hasActive: false,
  dockMounted: false,
  focusToken: 0,

  applyEvent: (ev) => {
    const key = sessionKeyOf(ev);
    const prev = get().sessions.get(key) ?? null;
    const reduced = reduceFeedEvent(prev, ev);
    if (!reduced || reduced === prev) return;
    const next = new Map(get().sessions);
    next.set(key, reduced);
    // 会话数上限：优先淘汰最旧的非 active 会话；全 active（异常场景）则淘汰最旧。
    if (next.size > MAX_SESSIONS) {
      let victim: AgentFeedSession | null = null;
      for (const s of next.values()) {
        if (s.key === key) continue;
        if (!victim) {
          victim = s;
          continue;
        }
        const sDone = s.status !== 'active';
        const vDone = victim.status !== 'active';
        if ((sDone && !vDone) || (sDone === vDone && s.updatedAt < victim.updatedAt)) {
          victim = s;
        }
      }
      if (victim) next.delete(victim.key);
    }
    set({ sessions: next, hasActive: deriveHasActive(next) });
  },

  openPanel: (feedId) => {
    const { sessions, selectedKey, dockMounted, focusToken } = get();
    let nextSelected = selectedKey;
    if (feedId) {
      const list = sessionsForFeed(sessions, feedId);
      if (list.length > 0) {
        nextSelected = list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).key;
      }
    }
    if (!nextSelected || !sessions.has(nextSelected)) {
      let latest: AgentFeedSession | null = null;
      for (const s of sessions.values()) {
        if (!latest || s.updatedAt > latest.updatedAt) latest = s;
      }
      nextSelected = latest?.key ?? null;
    }
    if (dockMounted) {
      set({ selectedKey: nextSelected, focusToken: focusToken + 1 });
    } else {
      set({ panelOpen: true, selectedKey: nextSelected });
    }
  },

  closePanel: () => set({ panelOpen: false }),

  setDockMounted: (mounted) =>
    set(mounted ? { dockMounted: true, panelOpen: false } : { dockMounted: false }),

  selectSession: (key) => set({ selectedKey: key }),

  clearAll: () =>
    set({ sessions: new Map(), panelOpen: false, selectedKey: null, hasActive: false }),
}));

/** 便捷断言：某统一进度任务 id 是否有观测会话（进度面板「查看过程」显隐）。 */
export function hasFeedSessions(
  sessions: Map<string, AgentFeedSession>,
  feedId: string,
): boolean {
  for (const s of sessions.values()) {
    if (s.feedId === feedId) return true;
  }
  return false;
}
