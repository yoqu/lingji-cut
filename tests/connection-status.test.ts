import { describe, it, expect } from 'vitest';
import {
  deriveAgentConnection,
  deriveKacutConnection,
  deriveSonarConnection,
  formatRelativeTime,
  summarizeConnections,
  SONAR_ACTIVE_WINDOW_MS,
} from '../src/lib/connection-status';

const NOW = 1_700_000_000_000;

describe('deriveAgentConnection', () => {
  it('自动连接失败时报错并带出原因', () => {
    const entry = deriveAgentConnection('disconnected', 'pi 启动失败');
    expect(entry.level).toBe('error');
    expect(entry.detail).toBe('pi 启动失败');
  });

  it('思考中仍算已连接', () => {
    expect(deriveAgentConnection('prompting', null).level).toBe('connected');
  });
});

describe('deriveKacutConnection', () => {
  it('未启用时为 disabled，不参与汇总', () => {
    const entry = deriveKacutConnection({ enabled: false, baseUrl: 'http://127.0.0.1:8765' }, { status: 'idle' });
    expect(entry.level).toBe('disabled');
  });

  it('探测失败给出修复指引', () => {
    const entry = deriveKacutConnection({ enabled: true, baseUrl: 'http://127.0.0.1:8765' }, { status: 'failed' });
    expect(entry.level).toBe('error');
    expect(entry.detail).toContain('MCP 设置');
  });

  it('连上且有摘要时展示素材统计', () => {
    const entry = deriveKacutConnection(
      { enabled: true, baseUrl: 'http://127.0.0.1:8765' },
      { status: 'ok', digest: { libraryCount: 3, itemCount: 1234, kindCounts: { video: 800, image: 434 } } },
    );
    expect(entry.level).toBe('connected');
    expect(entry.detail).toBe('3 个库 · 1,234 条素材 · 视频 800 · 图片 434');
  });

  it('探测中不展示访问 token', () => {
    const entry = deriveKacutConnection(
      { enabled: true, baseUrl: 'http://127.0.0.1:8765/mcp?token=test-access-token' },
      { status: 'checking' },
    );
    expect(entry.detail).toContain('token=********');
    expect(entry.detail).not.toContain('test-access-token');
  });
});

describe('deriveSonarConnection', () => {
  const info = { port: 19820, token: 't', running: true, lastSeenAt: null };

  it('桥未启动为错误', () => {
    expect(deriveSonarConnection({ ...info, running: false }, NOW).level).toBe('error');
    expect(deriveSonarConnection(null, NOW).level).toBe('error');
  });

  it('从未被访问时提示等待插件连接并给出端点', () => {
    const entry = deriveSonarConnection(info, NOW);
    expect(entry.level).toBe('idle');
    expect(entry.detail).toContain('http://127.0.0.1:19820');
  });

  it('活跃窗口内视为已连接，超窗降级为已配对', () => {
    expect(deriveSonarConnection({ ...info, lastSeenAt: NOW - 60_000 }, NOW).level).toBe('connected');
    expect(
      deriveSonarConnection({ ...info, lastSeenAt: NOW - SONAR_ACTIVE_WINDOW_MS - 1 }, NOW).level,
    ).toBe('idle');
  });
});

describe('summarizeConnections', () => {
  const entry = (level: 'connected' | 'idle' | 'error' | 'disabled' | 'connecting') =>
    ({ key: 'agent' as const, label: 'x', level, detail: '' });

  it('全部连上为连接正常', () => {
    expect(summarizeConnections([entry('connected'), entry('connected'), entry('disabled')])).toEqual({
      level: 'connected',
      text: '连接正常',
    });
  });

  it('有异常时优先报异常数量', () => {
    expect(summarizeConnections([entry('error'), entry('connected'), entry('idle')])).toEqual({
      level: 'error',
      text: '1 项连接异常',
    });
  });

  it('无异常但未全连上时报连接比例（不含未启用项）', () => {
    expect(summarizeConnections([entry('connected'), entry('idle'), entry('disabled')])).toEqual({
      level: 'idle',
      text: '1/2 已连接',
    });
  });
});

describe('formatRelativeTime', () => {
  it('按分钟 / 小时 / 天降级', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 天前');
  });
});
