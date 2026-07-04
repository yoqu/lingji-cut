import { describe, expect, it, vi } from 'vitest';
import { extractMotionCardSource } from '../src/lib/llm/content';
import type { AISettings } from '../src/types/ai';

const COMPONENT = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
export default function MotionCard() {
  const frame = useCurrentFrame();
  return <AbsoluteFill>{frame}</AbsoluteFill>;
}`;

describe('extractMotionCardSource', () => {
  it('extracts the TSX from a fenced ```tsx block surrounded by prose', () => {
    const raw = `好的，这是卡片组件：\n\n\`\`\`tsx\n${COMPONENT}\n\`\`\`\n\n希望符合要求。`;
    expect(extractMotionCardSource(raw)).toBe(COMPONENT);
  });

  it('returns raw content when there is no fence but it is a valid component', () => {
    expect(extractMotionCardSource(`\n${COMPONENT}\n`)).toBe(COMPONENT);
  });

  it('prefers the fenced block that contains export default when multiple blocks exist', () => {
    const raw = `先看依赖：\n\n\`\`\`bash\nnpm i remotion\n\`\`\`\n\n再看组件：\n\n\`\`\`tsx\n${COMPONENT}\n\`\`\``;
    expect(extractMotionCardSource(raw)).toBe(COMPONENT);
  });

  it('throws when the model returned no usable component (no export default)', () => {
    expect(() => extractMotionCardSource('抱歉，我无法生成这个卡片。')).toThrow(/motionCard/);
  });

  it('throws when the component has export default but no JSX (incomplete / stubbed body)', () => {
    // 真实失败样本：模型只搭了变量骨架就用注释收尾，没有 return 任何 JSX → 渲染全黑
    const stub = `import { useCurrentFrame } from 'remotion';
export default function PCBInsight() {
  const frame = useCurrentFrame();
  const durationInFrames = 180;
  // ... build out the rest
}`;
    expect(() => extractMotionCardSource(stub)).toThrow(/完整|JSX|请重新生成/);
  });

  it('throws when the component only returns null (renders nothing)', () => {
    expect(() => extractMotionCardSource('export default () => null;')).toThrow(/完整|JSX|请重新生成/);
  });
});

// generateMotionCardSource（直连流式 TSX 生成）已随「Motion TSX 收敛到 pi 多 agent 编排器」
// 移除；fence 抽取器保留为纯工具，上面的用例即其全部契约。多 agent 编排的验证/修复循环
// 见 tests/motion-agent-run.test.ts。
