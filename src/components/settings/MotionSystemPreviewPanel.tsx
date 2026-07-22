/**
 * MotionSystemPreviewPanel —— 设置页「动效系统预览」面板。
 *
 * 按视觉论证分镜（cards.animation）的 13 个载体分组，把段落卡片生成（cards.segment v24）
 * 可用的每个原语变体以真实渲染路径实时预览：当前生效的「项目统一风格」motionTokens
 * 注入 demo TSX → 主进程 esbuild 批量编译 → CardHost + @remotion/player 播放。
 * 切换风格预设即整体换肤。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Tabs, TabsList, TabsTrigger } from '../../ui';
import { getMotionTokensBlock, getStylePresetById } from '../../lib/card-style';
import {
  MOTION_DEMO_CARDS,
  MOTION_DEMO_CARRIER_META,
  buildDemoCardTsx,
  type MotionDemoCard,
} from '../../remotion/motion-kit/demo-cards';
import { MotionDemoPreview } from '../MotionDemoPreview';
import styles from './MotionSystemPreviewPanel.module.css';

type Scope = 'global' | 'project';

interface MotionSystemPreviewPanelProps {
  /** 当前 scope 生效的风格预设 id（与「项目统一风格」同一解析结果） */
  presetId: string;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  hasProject: boolean;
}

export function MotionSystemPreviewPanel({
  presetId,
  scope,
  onScopeChange,
  hasProject,
}: MotionSystemPreviewPanelProps) {
  const preset = getStylePresetById(presetId);
  const compile =
    typeof window !== 'undefined' ? window.electronAPI?.compileMotionCards : undefined;
  const [compiled, setCompiled] = useState<Record<string, string>>({});
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);

  useEffect(() => {
    if (!compile) return;
    let cancelled = false;
    setCompiling(true);
    setCompileError(null);
    setCompiled({});
    const tokensJson = getMotionTokensBlock(presetId);
    const cards = MOTION_DEMO_CARDS.map((demo) => ({
      overlayId: demo.id,
      tsx: buildDemoCardTsx(demo, tokensJson),
    }));
    compile({ cards })
      .then((map) => {
        if (!cancelled) setCompiled(map);
      })
      .catch((error) => {
        if (!cancelled) {
          setCompileError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setCompiling(false);
      });
    return () => {
      cancelled = true;
    };
  }, [presetId, compile]);

  const groups = useMemo(
    () =>
      MOTION_DEMO_CARRIER_META.map((meta) => ({
        meta,
        demos:
          meta.carrier === 'supplementary'
            ? MOTION_DEMO_CARDS.filter((d) => d.supplementary)
            : MOTION_DEMO_CARDS.filter((d) => !d.supplementary && d.carrier === meta.carrier),
      })).filter((group) => group.demos.length > 0),
    [],
  );

  const carrierLabelOf = (demo: MotionDemoCard): string =>
    demo.supplementary
      ? (MOTION_DEMO_CARRIER_META.find((m) => m.carrier === 'supplementary')?.label ?? '补充')
      : (MOTION_DEMO_CARRIER_META.find((m) => m.carrier === demo.carrier)?.label ?? demo.carrier);

  if (!compile) {
    return (
      <Alert
        variant="info"
        description="当前环境不支持动效编译预览（需在桌面应用内打开设置页）。"
      />
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <div className={styles.headerText}>
          <p className={styles.lead}>
            分镜选载体 → 出卡选原语变体。以下为内置动效系统的全部载体与原语，按当前生效的项目统一风格实时渲染。
          </p>
          <div className={styles.presetLine}>
            <span>当前风格</span>
            <Badge variant="info" size="xs">{preset.name}</Badge>
            <span className={styles.presetNote}>在「项目统一风格」中切换预设，此处全部动效即时换肤</span>
          </div>
        </div>
        <Tabs value={scope} onValueChange={(next) => onScopeChange(next as Scope)}>
          <TabsList>
            <TabsTrigger value="global">全局</TabsTrigger>
            <TabsTrigger value="project" disabled={!hasProject}>
              当前项目
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {compileError ? (
        <Alert variant="error" description={`动效 demo 编译失败：${compileError}`} />
      ) : null}

      {groups.map(({ meta, demos }) => (
        <section key={meta.carrier} className={styles.group}>
          <header className={styles.groupHeader}>
            <span className={styles.groupLabel}>{meta.label}</span>
            <span className={styles.groupDesc}>{meta.description}</span>
          </header>
          <div className={styles.grid}>
            {demos.map((demo) => (
              <MotionDemoPreview
                key={demo.id}
                demo={demo}
                carrierLabel={carrierLabelOf(demo)}
                compiledJs={compiled[demo.id]}
                loading={compiling}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
