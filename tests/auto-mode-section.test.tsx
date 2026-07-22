// tests/auto-mode-section.test.tsx
//
// 注意：项目测试环境为 vitest node + 静态 SSR（renderToStaticMarkup），
// 未引入 @testing-library/react / jsdom。此文件遵循项目惯例，使用 SSR
// 做结构断言；对受控组件的 onToggle / onChangeParams 行为，通过直接
// 调用 React 元素树上的 props 函数进行验证（组件本身是纯函数式的、
// 无内部状态）。
//
// AutoModeSection 现已迁移至系统 UI 组件库（Checkbox / Select），
// 不再渲染原生 <input type="checkbox"> / <select> 的语义结构，
// 因此本测试通过 React 元素树（而非 SSR HTML 文本）验证受控行为。
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoModeSection, type AutoModeSectionProps } from '../src/components/script/AutoModeSection';

function makeBaseProps(overrides: Partial<AutoModeSectionProps> = {}): AutoModeSectionProps {
  return {
    enabled: false,
    onToggle: vi.fn(),
    params: { templateId: 'news-broadcast', roleId: 'none', voiceId: 'female-shaonv' },
    onChangeParams: vi.fn(),
    // roleOptions 由父组件从 getAllRoles() 派生，已合并内置模板 + 自定义角色
    roleOptions: [
      { value: 'none', label: '不指定角色' },
      { value: 'news-broadcast', label: '新闻播报' },
      { value: 'host', label: '主播' },
    ],
    voiceOptions: [
      { value: 'female-shaonv', label: '少女音' },
      { value: 'male-qn-qingse', label: '青涩青年男声' },
    ],
    ...overrides,
  };
}

/**
 * 在 React 元素树中按 aria-label 查找首个匹配节点，
 * 用于在不依赖 DOM 的情况下读取受控组件的 props（含 onChange）。
 */
function findByAriaLabel(node: unknown, ariaLabel: string): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByAriaLabel(child, ariaLabel);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown> | null;
  if (props && (props['aria-label'] === ariaLabel || props.ariaLabel === ariaLabel)) {
    return node;
  }
  if (props && 'children' in props) {
    return findByAriaLabel(props.children, ariaLabel);
  }
  return null;
}

describe('AutoModeSection', () => {
  it('renders the toggle and hides params when disabled', () => {
    const html = renderToStaticMarkup(<AutoModeSection {...makeBaseProps()} />);
    // 系统 Checkbox 内部仍渲染 type="checkbox" 的隐藏 input，未勾选时无 checked 属性
    expect(html).toContain('type="checkbox"');
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    // 标题与说明可读
    expect(html).toContain('自动剪辑');
    expect(html).toContain('生成口播稿');
    // 未启用时不渲染参数下拉文案
    expect(html).not.toContain('不指定角色');
    expect(html).not.toContain('少女音');
  });

  it('toggling fires onToggle with the new boolean state', () => {
    const onToggle = vi.fn();
    const tree = AutoModeSection(makeBaseProps({ onToggle }));
    const checkbox = findByAriaLabel(tree, '启用自动剪辑');
    expect(checkbox).not.toBeNull();
    const onChange = (checkbox!.props as { onChange: (next: boolean) => void }).onChange;
    expect(onChange).toBeTypeOf('function');
    onChange(true);
    expect(onToggle).toHaveBeenCalledWith(true);
    onChange(false);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('shows params when enabled and reflects current selections', () => {
    const props = makeBaseProps({ enabled: true });
    const html = renderToStaticMarkup(<AutoModeSection {...props} />);
    // 启用态：隐藏 input 带 checked
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
    // 两个下拉的当前选中文案在系统 Select 触发器中可见
    expect(html).toContain('不指定角色');
    expect(html).toContain('少女音');

    // 元素树层面校验 Select 的 value 与 options 已正确传入
    const tree = AutoModeSection(props);
    // 重构后不再单独暴露 "写稿模板"：与写稿工作台保持一致，只保留角色 + 音色
    expect(findByAriaLabel(tree, '写稿模板')).toBeNull();
    const role = findByAriaLabel(tree, '写稿角色');
    const voice = findByAriaLabel(tree, '口播音色');
    expect(role).not.toBeNull();
    expect(voice).not.toBeNull();
    expect((role!.props as { value: string }).value).toBe('none');
    expect((voice!.props as { value: string }).value).toBe('female-shaonv');
  });

  it('旧项目缺少 productionMode 时默认显示一键成片，并提供导演确认', () => {
    const html = renderToStaticMarkup(
      <AutoModeSection {...makeBaseProps({ enabled: true })} />,
    );
    expect(html).toContain('制作模式');
    expect(html).toContain('一键成片');
    expect(html).toContain('导演确认');
    expect(html).toMatch(/aria-pressed="true"[^>]*>一键成片/u);
  });

  it("mode='always' 时不渲染启用勾选框，字段始终展开", () => {
    const html = renderToStaticMarkup(
      <AutoModeSection
        {...makeBaseProps({ mode: 'always', enabled: false })}
      />,
    );
    expect(html).not.toContain('启用自动剪辑');
    // 字段区始终展开
    expect(html).toContain('不指定角色');
    expect(html).toContain('少女音');
  });

  it('渲染背景音乐开关，缺省勾选，bgmEnabled=false 时不勾选', () => {
    const bgm = findByAriaLabel(
      AutoModeSection(makeBaseProps({ mode: 'always' })),
      '生成背景音乐',
    );
    expect(bgm).not.toBeNull();
    expect((bgm!.props as { checked: boolean }).checked).toBe(true);

    const props = makeBaseProps({ mode: 'always' });
    props.params = { ...props.params, bgmEnabled: false };
    const off = findByAriaLabel(AutoModeSection(props), '生成背景音乐');
    expect((off!.props as { checked: boolean }).checked).toBe(false);
  });

  it('传入 modelOptions 时渲染写稿模型字段，并通过 onChangeModelBinding 回传解码后的绑定', () => {
    const onChangeModelBinding = vi.fn();
    const props = makeBaseProps({
      mode: 'always',
      modelOptions: [
        { value: 'p1::gpt-5.4', label: 'Provider 1 / gpt-5.4' },
        { value: 'p2::claude-sonnet-4-6', label: 'Provider 2 / claude-sonnet-4-6' },
      ],
      modelBinding: { providerId: 'p1', model: 'gpt-5.4' },
      onChangeModelBinding,
    });
    const html = renderToStaticMarkup(<AutoModeSection {...props} />);
    expect(html).toContain('写稿模型');
    expect(html).toContain('Provider 1 / gpt-5.4');

    const tree = AutoModeSection(props);
    const modelSelect = findByAriaLabel(tree, '写稿模型');
    expect(modelSelect).not.toBeNull();
    expect((modelSelect!.props as { value: string }).value).toBe('p1::gpt-5.4');
    const onChange = (modelSelect!.props as {
      onChange: (e: { target: { value: string } }) => void;
    }).onChange;
    onChange({ target: { value: 'p2::claude-sonnet-4-6' } });
    expect(onChangeModelBinding).toHaveBeenCalledWith({
      providerId: 'p2',
      model: 'claude-sonnet-4-6',
    });
  });

  it('未传 modelOptions 时不渲染写稿模型字段（向后兼容）', () => {
    const html = renderToStaticMarkup(
      <AutoModeSection {...makeBaseProps({ enabled: true })} />,
    );
    expect(html).not.toContain('写稿模型');
  });

  it('emits onChangeParams with merged patch when a select changes', () => {
    const onChangeParams = vi.fn();
    const tree = AutoModeSection(
      makeBaseProps({ enabled: true, onChangeParams }),
    );
    const voice = findByAriaLabel(tree, '口播音色');
    expect(voice).not.toBeNull();
    const onChange = (voice!.props as { onChange: (e: { target: { value: string } }) => void }).onChange;
    onChange({ target: { value: 'male-qn-qingse' } });
    expect(onChangeParams).toHaveBeenCalledWith({
      templateId: 'news-broadcast',
      roleId: 'none',
      voiceId: 'male-qn-qingse',
    });

    const role = findByAriaLabel(tree, '写稿角色');
    expect(role).not.toBeNull();
    const onRoleChange = (role!.props as { onChange: (e: { target: { value: string } }) => void }).onChange;
    onRoleChange({ target: { value: 'host' } });
    expect(onChangeParams).toHaveBeenLastCalledWith({
      templateId: 'news-broadcast',
      roleId: 'host',
      voiceId: 'female-shaonv',
    });
  });
});
