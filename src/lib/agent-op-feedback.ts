/**
 * 控制服务操作 → 界面反馈映射（纯逻辑，供 AgentOpOverlay 使用）。
 * 视觉呈现复用统一 AI 反馈体系的虚拟鼠标（AgentCursor），不在此发明新样式。
 */
import type { ControlOpEvent } from './electron-api';

/** 界面锚点区域；组件用 [data-agent-zone="<zone>"] 定位 */
export type AgentZone =
  | 'script'
  | 'timeline'
  | 'ai-panel'
  | 'cover'
  | 'publish'
  | 'settings'
  | 'status-bar';

const ZONE_RULES: Array<{ test: RegExp; zone: AgentZone }> = [
  { test: /^lingji_(read_script|update_script|write_script|review_script|get_editor_state|start_video_import|get_video_import_status)$/, zone: 'script' },
  { test: /^lingji_(generate_audio|export_video)$/, zone: 'timeline' },
  { test: /^lingji_(analyze_subtitles|list_cards|get_card|get_card_context|update_card|delete_card|validate_card|regenerate_card|regenerate_card_media|convert_card|sculpt_card)$/, zone: 'ai-panel' },
  { test: /^lingji_generate_cover/, zone: 'cover' },
  { test: /^lingji_generate_covers$/, zone: 'cover' },
  { test: /^lingji_(publish_video|list_publish_accounts|check_publish_account)$/, zone: 'publish' },
  { test: /^lingji_(get_settings|update_settings)$/, zone: 'settings' },
];

export function zoneForOp(op: string): AgentZone {
  for (const rule of ZONE_RULES) {
    if (rule.test.test(op)) return rule.zone;
  }
  return 'status-bar';
}

/** 只读操作：反馈更轻（短驻留、不显示完成勾） */
export function isReadOp(op: string): boolean {
  return /^lingji_(get_|list_|read_)/.test(op);
}

/** 任务型操作：成功即「任务已提交」，指针交接到底部进度条 */
export function isTaskOp(op: string): boolean {
  return /^lingji_(generate_|analyze_subtitles|export_video|publish_video|regenerate_|sculpt_card|convert_card|start_video_import)/.test(op);
}

export interface AgentActivity {
  op: string;
  /** 展示文案（工具中文标题） */
  label: string;
  zone: AgentZone;
  phase: 'start' | 'success' | 'error';
  error?: string;
  read: boolean;
  task: boolean;
  ts: number;
}

export function toActivity(ev: ControlOpEvent): AgentActivity {
  return {
    op: ev.op,
    label: ev.title,
    zone: zoneForOp(ev.op),
    phase: ev.phase,
    error: ev.error,
    read: isReadOp(ev.op),
    task: isTaskOp(ev.op),
    ts: ev.ts,
  };
}

/** 各阶段最短驻留时长（ms）：保证肉眼可感知，不闪没 */
export function displayDurationMs(activity: AgentActivity): number {
  if (activity.phase === 'error') return 2600;
  if (activity.phase === 'success') return activity.task ? 1600 : 1000;
  return activity.read ? 900 : 1400;
}
