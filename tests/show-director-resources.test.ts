import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROLE_URL = new URL('../resources/pi-agents/agents/show-director.md', import.meta.url);
const CARD_DIRECTOR_URL = new URL('../resources/pi-agents/agents/card-director.md', import.meta.url);
const SKILL_URL = new URL(
  '../resources/pi-agents/skills/show-director-workflow/',
  import.meta.url,
);

function read(relative: string): string {
  return readFileSync(new URL(relative, SKILL_URL), 'utf8');
}

describe('show-director Pi 资源契约', () => {
  it('卡片导演资源要求可量化信息使用阿拉伯数字', () => {
    const role = readFileSync(CARD_DIRECTOR_URL, 'utf8');
    expect(role).toContain('一律使用阿拉伯数字');
    expect(role).toContain('179,841辆');
    expect(role).toContain('不得换算或四舍五入');
  });

  it('角色只开放受控导演工具，并要求自主导航而不是一次性吐 JSON', () => {
    const role = readFileSync(ROLE_URL, 'utf8');

    expect(role).toContain('name: show-director');
    expect(role).toContain('version: 8');
    expect(role).toContain(
      'tools: [director_get_context, director_search_materials, director_inspect_material, director_initialize_working_draft, director_patch_working_segments, director_read_working_draft, director_validate_working_draft, director_submit_working_draft, director_validate_draft, director_submit_draft]',
    );
    expect(role).toContain('不是一次性输出一段 JSON');
    expect(role).toContain('每批最多 8 个');
    expect(role).toContain('不要在普通文本或一次工具参数中重吐整片 JSON');
    expect(role).toContain('“观点 -> 证据 -> 解释”关系图');
    expect(role).toContain('框架不规定第二、第三个工具动作');
    expect(role).toContain('不得在没有任何工作草案检查点时连续批量搜索');
    expect(role).toContain('已恢复的 `workingDraftCheckpoint`');
    expect(role).toContain('任何头部或镜头修改都会使既有校验失效');
    expect(role).toContain('不得绕过校验直接提交');
    expect(role).not.toMatch(/^tools:.*\b(?:bash|shell|curl|write|edit)\b/mu);
  });

  it('组合镜头使用双重不可替代而非机械配额，并覆盖零组合原因', () => {
    const role = readFileSync(ROLE_URL, 'utf8');
    const strategy = read('references/agent-composite-strategy.md');
    const contract = read('references/draft-contract.md');

    expect(role).toContain('素材不可替代');
    expect(role).toContain('信息层不可替代');
    expect(role).toContain('不得设置素材或 composite 的数量、占比、连续段数、首尾禁用等机械配额');
    expect(role).toContain('`mediaIndispensability`、`graphicsIndispensability`');
    expect(role).toContain('zeroCompositeReason');
    expect(role).toContain('草案顶层');
    expect(role).not.toContain('audit.zeroCompositeReason`，');
    expect(strategy).toContain('前两项必须同时为“是”');
    expect(strategy).toContain('不要写画中画、分屏、左右布局、坐标、CSS');
    expect(contract).toContain('`zeroCompositeReason`: 草案顶层字段');
    expect(contract).not.toContain('`audit.zeroCompositeReason`');
    expect(contract).toContain('不要提交运行时方案中的 `segmentId`、`startMs`、`endMs` 或 `preferredCarrier`');
    expect(contract).toContain('`context`、`explain`、`compare`、`evidence`、`emphasis`、`transition`、`breath`');
    expect(strategy).toContain('零个或多个都可以');
  });

  it('候选素材必须先检索再检视，且显式处理 fallback 与 blocked', () => {
    const role = readFileSync(ROLE_URL, 'utf8');
    const tools = read('references/tool-contract.md');

    expect(role).toContain('命中关键词不等于选中素材');
    expect(role).toContain('不得只按最高分自动采用');
    expect(role).toContain('检索分只用于候选排序，不是采用门槛');
    expect(role).toContain('相关且不误导的通用真实 B-roll');
    expect(role).toContain('通用 B-roll 不得暗示自己就是该事件现场');
    expect(role).toContain('`shotKey` 与具体 `narrativeNeed`');
    expect(role).toContain('每轮精检 1-2 个候选');
    expect(role).toContain('默认使用 `kind="any"`');
    expect(role).toContain('查询序列先覆盖来源特定的事实证据，再按当前语义动态联想到');
    expect(role).toContain('视频候选弱时必须保留并补看图片候选');
    expect(role).toContain('实时生成首选 `query` 与 1-4 个 `relatedQueries`');
    expect(role).toContain('`materialLibrary.sceneTagCatalog` 的完整真实标签目录');
    expect(role).toContain('选择 1-6 个实际存在的 `selectedTags`');
    expect(role).toContain('旧素材服务没有该字段时才回退 `topSceneTags`');
    expect(role).toContain('不要要求一次性读取素材路径、OCR、ASR、代表帧或全部条目明细');
    expect(role).toContain('不得套用跨项目固定词典');
    expect(role).toContain('video+image 双媒介审计');
    expect(role).toContain('`context`、`transition`、`breath`');
    expect(role).toContain('每个 composite 必须显式选择 `fallbackPolicy`');
    expect(role).toContain('`strategyStatus="blocked"`');
    expect(role).toContain('显式 `fallbackDecision`');
    expect(tools).toContain('无法检视的 required 候选必须 blocked');
    expect(tools).toContain('相关度只用于召回排序，不是采用门槛');
    expect(tools).toContain('人工或 Agent 明确选择的低分候选可以执行');
    expect(tools).toContain('`shotKey`、`narrativeNeed`');
    expect(tools).toContain('版本冲突时拒绝覆盖');
    expect(tools).toContain('## `director_initialize_working_draft`');
    expect(tools).toContain('## `director_patch_working_segments`');
    expect(tools).toContain('## `director_read_working_draft`');
    expect(tools).toContain('## `director_validate_working_draft`');
    expect(tools).toContain('## `director_submit_working_draft`');
    expect(tools).toContain('同 key 修订不会产生重复项');
    expect(tools).toContain('不会返回完整长片对象');
    expect(tools).toContain('进程重启或任务中断');
    expect(tools).toContain('`queriesTried`、成功完成的 `kinds`');
    expect(tools).toContain('完整 `sceneTagCatalog`');
    expect(tools).toContain('1-6 个真实 `selectedTags`');
    expect(tools).toContain('目录外标签返回 `invalid-input` 和 `unknownTags`');
    expect(tools).toContain('实际命中的 `query`');
    expect(tools).toContain('工具不内置行业关键词、同义词映射或语义回退规则');
  });

  it('标题、简介、封面标题和用户锁定规则不会漂移', () => {
    const role = readFileSync(ROLE_URL, 'utf8');
    const contract = read('references/draft-contract.md');

    expect(role).toContain('8-14 个汉字');
    expect(role).toContain('30-80 字');
    expect(role).toContain('封面提示词中的画面主标题必须逐字等于作品标题');
    expect(role).toContain('用户锁定不可覆盖');
    expect(contract).toContain('重新编排时复制锁定值');
    expect(contract).toContain('不得批准、生成卡片、出封面图、生成声音或改时间线');
  });

  it('skill 引用与 JSON 示例完整可读', () => {
    const skill = read('SKILL.md');
    expect(skill).toContain('version: 8');
    const linkedFiles = [
      'references/agent-composite-strategy.md',
      'references/draft-contract.md',
      'references/tool-contract.md',
      'examples/agent-composite-shot.json',
      'examples/zero-composite-audit.json',
    ];

    for (const file of linkedFiles) {
      expect(skill).toContain(file);
      expect(existsSync(new URL(file, SKILL_URL)), file).toBe(true);
    }

    const composite = JSON.parse(read('examples/agent-composite-shot.json')) as Record<string, unknown>;
    const zero = JSON.parse(read('examples/zero-composite-audit.json')) as Record<string, unknown>;
    expect(composite).toMatchObject({
      key: expect.any(String),
      firstEntryIndex: expect.any(Number),
      lastEntryIndex: expect.any(Number),
      carrier: expect.any(String),
      purpose: 'evidence',
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      fallbackPolicy: 'block',
      strategyStatus: 'ready',
    });
    expect(composite).not.toHaveProperty('segmentId');
    expect(composite).not.toHaveProperty('preferredCarrier');
    expect(composite.mediaIndispensability).toEqual(expect.any(String));
    expect(composite.graphicsIndispensability).toEqual(expect.any(String));
    expect(composite.selectedAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: expect.any(String), usage: 'required' }),
    ]));
    expect(zero.zeroCompositeReason).toEqual(expect.any(String));
    expect(String(zero.zeroCompositeReason).length).toBeGreaterThan(40);
    expect(zero).not.toHaveProperty('audit');
    expect(zero).not.toHaveProperty('blocked');
    const purposes = new Set(['context', 'explain', 'compare', 'evidence', 'emphasis', 'transition', 'breath']);
    for (const segment of zero.segments as Array<Record<string, unknown>>) {
      expect(segment).toMatchObject({
        key: expect.any(String),
        firstEntryIndex: expect.any(Number),
        lastEntryIndex: expect.any(Number),
        carrier: expect.any(String),
      });
      expect(purposes.has(String(segment.purpose))).toBe(true);
      expect(segment).not.toHaveProperty('segmentId');
      expect(segment).not.toHaveProperty('preferredCarrier');
    }
  });
});
