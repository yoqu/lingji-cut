import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StagePipeline } from '../src/components/agent-feed/StagePipeline';
import { AgentFeedViewBody } from '../src/components/agent-feed/AgentFeedView';
import { useAgentFeedStore, type AgentFeedEvent } from '../src/store/agent-feed';

/** SSR 渲染下 zustand 只读 initial state，因此测试用展示层 + 显式 props。 */
function renderFeed(): string {
  const { sessions, selectedKey } = useAgentFeedStore.getState();
  return renderToStaticMarkup(
    <AgentFeedViewBody sessions={sessions} selectedKey={selectedKey} onSelectSession={() => {}} />,
  );
}

let seq = 0;
function ev(partial: Partial<AgentFeedEvent> & Pick<AgentFeedEvent, 'kind' | 'role'>): AgentFeedEvent {
  seq += 1;
  return { feedId: 'task-1', cardKey: 'seg-1', cardLabel: '开场钩子', seq, ts: 1000 + seq, ...partial };
}

beforeEach(() => {
  useAgentFeedStore.getState().clearAll();
  seq = 0;
});

describe('StagePipeline', () => {
  it('渲染四个阶段节点、状态与重试角标', () => {
    const html = renderToStaticMarkup(
      <StagePipeline
        stages={{
          director: { status: 'done' },
          sculpt: { status: 'active', round: 2 },
          mechqa: { status: 'pending' },
          review: { status: 'pending' },
        }}
      />,
    );
    expect(html).toContain('导演');
    expect(html).toContain('雕刻');
    expect(html).toContain('质检');
    expect(html).toContain('审查');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('↻2');
  });
});

describe('AgentFeedView', () => {
  it('无会话时渲染空态', () => {
    expect(renderFeed()).toContain('暂无生成过程');
  });

  it('渲染卡片会话：角色名、模型徽标与阶段标注；无 model 时回落"默认模型"', () => {
    const apply = useAgentFeedStore.getState().applyEvent;
    apply(ev({ role: 'orchestrator', kind: 'phase', text: '导演', stage: 'director' }));
    apply(ev({ role: 'director', kind: 'text', text: '分镜设计', model: 'prov/dir-model' }));
    apply(ev({ role: 'orchestrator', kind: 'phase', text: '雕刻', stage: 'sculpt' }));
    apply(ev({ role: 'sculptor', kind: 'text', text: '写组件' })); // 无 model → 默认模型
    const html = renderFeed();
    expect(html).toContain('开场钩子');
    expect(html).toContain('导演');
    expect(html).toContain('dir-model'); // 模型徽标显示短名
    expect(html).toContain('默认模型');
    expect(html).toContain('data-stage="director"');
    expect(html).toContain('data-stage="sculpt"');
  });

  it('多卡会话渲染卡片轨（每卡一个头像）', () => {
    const apply = useAgentFeedStore.getState().applyEvent;
    apply(ev({ role: 'director', kind: 'text', text: 'a', cardKey: 'seg-1', cardLabel: '卡一' }));
    apply(ev({ role: 'director', kind: 'text', text: 'b', cardKey: 'seg-2', cardLabel: '卡二' }));
    const html = renderFeed();
    expect(html).toContain('卡一');
    expect(html).toContain('卡二');
  });
});
