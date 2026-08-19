import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getBuiltinPromptTemplate,
  renderUserPromptWithLock,
  type PromptKind,
  type PromptTemplate,
} from '../src/lib/prompts';
import { parseSegmentPlanningResult } from '../src/lib/ai-analysis';

const CUSTOM_TEMPLATE: PromptTemplate = {
  name: 'custom',
  user: '用户自定义提示词，不包含任何真实性约束。',
};

function renderLocked(kind: PromptKind): string {
  return renderUserPromptWithLock(kind, CUSTOM_TEMPLATE, {});
}

describe('真实事件画面真实性铁律', () => {
  it('导演制作规则明确禁止用写实 AI 画面冒充真实现场', () => {
    const director = getBuiltinPromptTemplate('production.director').user;

    expect(director).toContain('真实性与新闻伦理');
    expect(director).toContain('上市敲钟');
    expect(director).toContain('禁止用 AI 生成可被误认为真实现场记录的写实画面');
    expect(director).toContain('卡通或编辑插画');
  });

  it.each<PromptKind>([
    'planning.segment',
    'cover.regeneration',
    'motion.bible',
    'cards.animation',
    'card.image',
    'card.video',
  ])('%s 的不可编辑契约始终保留真实性规则', (kind) => {
    const prompt = renderLocked(kind);

    expect(prompt).toContain('真实性与新闻伦理');
    expect(prompt).toContain('真实素材');
    expect(prompt).toContain('卡通或编辑插画');
  });

  it('不可编辑契约区分来源特定证据与不误导的通用 B-roll', () => {
    const planning = renderLocked('planning.segment');
    const bible = renderLocked('motion.bible');

    expect(planning).toContain('evidence 画面必须使用能核验到对应事实的来源特定素材');
    expect(planning).toContain('context、emotion、demonstration 与 breath');
    expect(planning).toContain('相关且不误导的通用真实 B-roll');
    expect(planning).toContain('不要给 image 或 footage 设置数量、占比、连续段数或首尾配额');
    expect(bible).toContain('不得设置素材或 agent-composite 的数量、占比、连续段数和首尾配额');
  });

  it('Motion Card 导演角色把同一规则作为最高优先级铁律', () => {
    const role = readFileSync(
      new URL('../resources/pi-agents/agents/card-director.md', import.meta.url),
      'utf8',
    );

    expect(role).toContain('version: 9');
    expect(role).toContain('最高优先级铁律');
    expect(role).toContain('上市敲钟');
    expect(role).toContain('manual-only');
    expect(role).toContain('diagram-prop');
  });

  it.each([
    {
      title: 'Momenta 登陆港交所',
      summary: '公司代表在上市敲钟仪式亮相',
      transcriptExcerpt: 'Momenta 正式挂牌上市。',
    },
    {
      title: '物理 AI 第一股进入资本市场',
      summary: 'Momenta 上市标志着物理 AI 第一股登陆资本市场',
      transcriptExcerpt: 'Momenta 上市标志着物理 AI 第一股登陆资本市场。',
    },
  ])('规划解析层把上市事件 image 强制降为 motion：$title', (event) => {
    const result = parseSegmentPlanningResult({
      segments: [
        {
          id: 'seg-news',
          ...event,
          startMs: 0,
          endMs: 6_000,
          visualType: 'image',
        },
      ],
      coverPrompts: ['封面'],
      summary: '总结',
      keywords: ['Momenta'],
    });

    expect(result?.segments[0]?.visualType).toBe('motion');
  });

  it('可核验素材入口保留真实事件 footage，不再误杀成 motion', () => {
    const result = parseSegmentPlanningResult({
      segments: [{
        id: 'seg-news-footage',
        title: '上市敲钟现场',
        summary: '公司正式上市',
        transcriptExcerpt: '公司代表参加上市敲钟仪式。',
        startMs: 0,
        endMs: 6_000,
        visualType: 'footage',
        footageQuery: '公司 上市 敲钟',
      }],
      coverPrompts: ['封面'],
      summary: '总结',
      keywords: ['上市'],
    });

    expect(result?.segments[0]).toMatchObject({
      visualType: 'footage',
      footageQuery: '公司 上市 敲钟',
    });
  });

  it('普通产品物件特写仍可保留 image', () => {
    const result = parseSegmentPlanningResult({
      segments: [
        {
          id: 'seg-product',
          title: '芯片样品特写',
          summary: '展示一枚芯片的封装与纹理',
          transcriptExcerpt: '这枚芯片采用新的封装。',
          startMs: 0,
          endMs: 6_000,
          visualType: 'image',
        },
      ],
      coverPrompts: ['封面'],
      summary: '总结',
      keywords: ['芯片'],
    });

    expect(result?.segments[0]?.visualType).toBe('image');
  });
});
