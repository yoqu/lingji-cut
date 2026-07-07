// tests/agent-op-feedback.test.ts
import { describe, it, expect } from 'vitest';
import {
  zoneForOp,
  isReadOp,
  isTaskOp,
  toActivity,
  displayDurationMs,
} from '../src/lib/agent-op-feedback';

describe('agent-op-feedback 映射', () => {
  it('op → zone 映射覆盖各域', () => {
    expect(zoneForOp('lingji_read_script')).toBe('script');
    expect(zoneForOp('lingji_review_script')).toBe('script');
    expect(zoneForOp('lingji_start_video_import')).toBe('script');
    expect(zoneForOp('lingji_generate_audio')).toBe('timeline');
    expect(zoneForOp('lingji_export_video')).toBe('timeline');
    expect(zoneForOp('lingji_analyze_subtitles')).toBe('ai-panel');
    expect(zoneForOp('lingji_update_card')).toBe('ai-panel');
    expect(zoneForOp('lingji_sculpt_card')).toBe('ai-panel');
    expect(zoneForOp('lingji_generate_covers')).toBe('cover');
    expect(zoneForOp('lingji_publish_video')).toBe('publish');
    expect(zoneForOp('lingji_update_settings')).toBe('settings');
    expect(zoneForOp('lingji_get_active_project')).toBe('status-bar');
    expect(zoneForOp('lingji_edit_lock')).toBe('status-bar');
  });

  it('读 / 任务分类正确', () => {
    expect(isReadOp('lingji_get_card')).toBe(true);
    expect(isReadOp('lingji_list_cards')).toBe(true);
    expect(isReadOp('lingji_update_card')).toBe(false);
    expect(isTaskOp('lingji_generate_audio')).toBe(true);
    expect(isTaskOp('lingji_publish_video')).toBe(true);
    expect(isTaskOp('lingji_update_card')).toBe(false);
  });

  it('toActivity 保留标题与阶段', () => {
    const a = toActivity({ op: 'lingji_generate_covers', title: '生成封面', phase: 'start', ts: 1 });
    expect(a).toMatchObject({ zone: 'cover', label: '生成封面', task: true, read: false });
  });

  it('驻留时长：错误 > 任务成功 > 写开始 > 读开始', () => {
    const mk = (op: string, phase: 'start' | 'success' | 'error') =>
      displayDurationMs(toActivity({ op, title: 't', phase, ts: 1 }));
    expect(mk('lingji_generate_audio', 'error')).toBeGreaterThan(mk('lingji_generate_audio', 'success'));
    expect(mk('lingji_generate_audio', 'success')).toBeGreaterThan(mk('lingji_update_card', 'success'));
    expect(mk('lingji_update_card', 'start')).toBeGreaterThan(mk('lingji_get_card', 'start'));
  });
});
