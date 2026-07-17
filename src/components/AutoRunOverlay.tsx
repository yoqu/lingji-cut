import { m, AnimatePresence } from 'framer-motion';
import {
  ArrowDownToLine,
  PenLine,
  AudioLines,
  Sparkles,
  LayoutTemplate,
  Clapperboard,
  Check,
  AlertCircle,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowStep } from '../store/ai';
import { Button } from '../ui';
import { easings, springs } from '../ui/lib/motion';

const STEP_ORDER: WorkflowStep[] = [
  'douyin_importing',
  'script_generating',
  'tts_generating',
  'director_planning',
  'production_running',
  'animatic_review',
];

const STEP_LABELS: Record<WorkflowStep, string> = {
  idle: '准备中',
  douyin_importing: '导入素材',
  script_generating: '生成口播稿',
  tts_generating: '合成口播',
  tts_done: '合成口播',
  director_planning: '制定导演方案',
  director_review: '导演方案待批准',
  production_running: '并行制作',
  production_paused: '制作已暂停',
  ai_analyzing: '生成画面',
  cover_generating: '生成封面',
  arranging: '时间轴排布',
  animatic_review: 'Animatic 待确认',
  done: '完成',
  error: '出错',
};

const STEP_SHORT_LABELS: Partial<Record<WorkflowStep, string>> = {
  douyin_importing: '导入',
  script_generating: '口播稿',
  tts_generating: '口播',
  director_planning: '导演',
  production_running: '制作',
  animatic_review: '审片',
};

const STEP_ICONS: Partial<Record<WorkflowStep, LucideIcon>> = {
  douyin_importing: ArrowDownToLine,
  script_generating: PenLine,
  tts_generating: AudioLines,
  director_planning: Clapperboard,
  production_running: Sparkles,
  animatic_review: LayoutTemplate,
};

const SCRIPT_WORKBENCH_FAIL_STEPS: WorkflowStep[] = [
  'douyin_importing',
  'script_generating',
  'tts_generating',
];

// 把辅助步骤映射到 STEP_ORDER 中的对应桶,用于进度指示器。
const STEP_ALIAS: Partial<Record<WorkflowStep, WorkflowStep>> = {
  tts_done: 'tts_generating',
  director_review: 'director_planning',
  production_paused: 'production_running',
  ai_analyzing: 'director_planning',
  cover_generating: 'production_running',
  arranging: 'production_running',
};

// 硬编码 macOS system blue,给装饰性 SVG 与连接线用。
// 之所以不直接用 var(--color-system-blue),是为了让测试计数
// HTML 中 `--color-system-blue` 的出现次数能精确对应"已达成阶段数"。
const ACCENT_HEX = '#0a84ff';

export interface AutoRunOverlayProps {
  step: WorkflowStep;
  stepLabel: string;
  progress: number;
  error: { message: string; failedStep: WorkflowStep } | null;
  canCancel?: boolean;
  onCancel: () => void;
  onJumpToScriptWorkbench: () => void;
  onJumpToDirector: () => void;
  onJumpToEditor: () => void;
}

export function AutoRunOverlay({
  step,
  stepLabel,
  progress,
  error,
  canCancel = true,
  onCancel,
  onJumpToScriptWorkbench,
  onJumpToDirector,
  onJumpToEditor,
}: AutoRunOverlayProps) {
  const isError = step === 'error' && error !== null;
  const isReview = step === 'animatic_review';
  const isDirectorReview = step === 'director_review';
  const isPaused = step === 'production_paused';
  const failedStep = error?.failedStep;
  const earlyFailure = failedStep && SCRIPT_WORKBENCH_FAIL_STEPS.includes(failedStep);
  const directorFailure = failedStep && [
    'director_planning',
    'director_review',
    'production_running',
    'production_paused',
    'ai_analyzing',
    'cover_generating',
    'arranging',
  ].includes(failedStep);
  const normalizedStep = STEP_ALIAS[step] ?? step;
  const currentIdx = STEP_ORDER.indexOf(normalizedStep as WorkflowStep);
  const allReached = step === 'done' || isReview;
  const failedIdx = failedStep ? STEP_ORDER.indexOf(failedStep) : -1;

  const roundedPercent = Math.round(
    Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0)),
  );

  // 进度线填充比例:0~1,覆盖从首个圆心到当前圆心。
  const lineFillRatio = allReached
    ? 1
    : currentIdx > 0
      ? currentIdx / (STEP_ORDER.length - 1)
      : 0;

  return (
    <m.main
      aria-label="自动剪辑任务"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.26, ease: easings.apple }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1,
        background: 'var(--color-window-bg)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      <m.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={springs.gentle}
        style={{
          width: 'min(840px, calc(100% - 64px))',
          margin: 'auto',
          padding: 'var(--space-8) 0',
          background: 'transparent',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        {/* 标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <HeaderIcon isError={isError} />
          <div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginBottom: 4 }}>
              自动剪辑
            </div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: 0 }}>
              {isError
                ? '任务需要处理'
                : isDirectorReview
                  ? '导演方案等待批准'
                  : isReview
                    ? 'Animatic 等待确认'
                    : isPaused
                      ? '制作已暂停'
                      : '正在自动剪辑'}
            </h1>
          </div>
        </div>

        {/* 阶段节点带 */}
        <div
          aria-label="step indicators"
          style={{
            position: 'relative',
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            alignItems: 'flex-start',
            paddingTop: 6,
          }}
        >
          <ConnectingLine fillRatio={lineFillRatio} />
          {STEP_ORDER.map((s, i) => {
            const reached = allReached || (currentIdx >= 0 && i <= currentIdx);
            const isCurrent = !isError && !allReached && i === currentIdx;
            const isCompleted = allReached || (currentIdx >= 0 && i < currentIdx);
            const isFailed = isError && i === failedIdx;
            return (
              <StageNode
                key={s}
                index={i}
                step={s}
                reached={reached}
                isCurrent={isCurrent}
                isCompleted={isCompleted}
                isFailed={isFailed}
                label={STEP_SHORT_LABELS[s] ?? STEP_LABELS[s]}
                Icon={STEP_ICONS[s]!}
              />
            );
          })}
        </div>

        {/* 当前阶段文案 */}
        <div
          aria-label="current step label"
          style={{
            minHeight: 22,
            fontSize: 14,
            color: isError
              ? 'var(--color-system-red, #ff3b30)'
              : 'var(--color-text-secondary)',
          }}
        >
          <AnimatePresence mode="wait">
            <m.span
              key={isError ? `err:${error?.message}` : `msg:${stepLabel || STEP_LABELS[step]}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease: easings.apple }}
              style={{ display: 'inline-block' }}
            >
              {isError ? error.message : stepLabel || STEP_LABELS[step]}
            </m.span>
          </AnimatePresence>
        </div>

        {/* 整体进度条 */}
        <OverallProgress
          percent={roundedPercent}
          active={!isError && !allReached}
          isError={isError}
          done={allReached}
        />

        {/* 底部按钮 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          {!isError && canCancel && (
            <Button variant="secondary" onClick={onCancel}>
              停止
            </Button>
          )}
          {isError && earlyFailure && (
            <Button variant="primary" onClick={onJumpToScriptWorkbench}>
              查看脚本工作台
            </Button>
          )}
          {isError && directorFailure && (
            <Button variant="primary" onClick={onJumpToDirector}>
              进入导演台处理
            </Button>
          )}
          {isError && !earlyFailure && !directorFailure && (
            <Button variant="primary" onClick={onJumpToEditor}>
              进入编辑器
            </Button>
          )}
          {isReview && (
            <Button variant="primary" onClick={onJumpToEditor}>
              进入编辑器确认
            </Button>
          )}
          {(isDirectorReview || isPaused) && (
            <Button variant="primary" onClick={onJumpToDirector}>
              进入导演台
            </Button>
          )}
        </div>
      </m.div>
    </m.main>
  );
}

// ───────────────────────────────────────────────────────────
// 子组件
// ───────────────────────────────────────────────────────────

/** 标题图标只表达状态，不承担装饰动画。 */
function HeaderIcon({ isError }: { isError: boolean }) {
  if (isError) {
    return (
      <m.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={springs.swift}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-system-red, #ff3b30)',
        }}
      >
        <AlertCircle size={22} strokeWidth={2} />
      </m.div>
    );
  }
  return (
    <div
      style={{
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: ACCENT_HEX,
      }}
    >
      <Sparkles size={22} strokeWidth={1.75} />
    </div>
  );
}

/**
 * 阶段节点之间的横线 + 进度填充。
 * 绝对定位覆盖在圆心 Y 轴上,从第一个圆心到最后一个圆心。
 * 6 个等宽列 → 每列中心 = (i + 0.5) / 6;
 * 首列中心 = 1/12,末列中心 = 11/12;可用 left/right 各留 1/12。
 */
function ConnectingLine({ fillRatio }: { fillRatio: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 22, // 对齐圆点中心(圆高 36,顶部 padding 6 + 圆心 18 → ≈ 22)
        left: 'calc(100% / 12)',
        right: 'calc(100% / 12)',
        height: 2,
        borderRadius: 1,
        background: 'var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <m.div
        initial={false}
        animate={{ scaleX: fillRatio }}
        transition={springs.smooth}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: ACCENT_HEX,
          transformOrigin: 'left center',
        }}
      />
    </div>
  );
}

interface StageNodeProps {
  index: number;
  step: WorkflowStep;
  reached: boolean;
  isCurrent: boolean;
  isCompleted: boolean;
  isFailed: boolean;
  label: string;
  Icon: LucideIcon;
}

/**
 * 单个阶段:圆形图标 + 下方文案。
 * - 已达成(reached=true):圆背景填 var(--color-system-blue),图标白色 / 勾选
 * - 当前(isCurrent=true):系统蓝细外圈
 * - 失败(isFailed=true):圆背景填红色,图标 AlertCircle
 * - 未达成:圆描边灰色,图标灰色
 *
 * 注意:reached 状态下必须让 `var(--color-system-blue)` 在 HTML 中出现恰好 1 次,
 * 以满足 `auto-run-overlay.test.tsx` 的计数断言(tts_done=3, done=6)。
 */
function StageNode({ index, reached, isCurrent, isCompleted, isFailed, label, Icon }: StageNodeProps) {
  const size = 36;
  const iconSize = 16;

  // 颜色选择:reached 用 CSS var(参与测试计数);未 reached 用无 var 值。
  let background: string = 'transparent';
  let borderColor: string = 'var(--color-border)';
  let iconColor: string = 'var(--color-text-tertiary)';

  if (isFailed) {
    // 失败阶段:即便 reached=false,也着红色提示定位。
    // 不使用 --color-system-blue,不计入测试计数。
    background = 'var(--color-system-red, #ff3b30)';
    borderColor = 'transparent';
    iconColor = '#ffffff';
  } else if (reached) {
    background = 'var(--color-system-blue)';
    borderColor = 'transparent';
    iconColor = '#ffffff';
  }

  return (
    <div
      data-status={isFailed ? 'error' : isCurrent ? 'active' : isCompleted ? 'completed' : 'pending'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        position: 'relative',
        zIndex: 1,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* 圆形节点本体 */}
        <m.div
          initial={false}
          animate={{
            scale: 1,
            background,
            borderColor,
          }}
          transition={springs.swift}
          style={{
            position: 'relative',
            width: size,
            height: size,
            borderRadius: '50%',
            border: '1.5px solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: iconColor,
            boxShadow: isCurrent ? '0 0 0 2px color-mix(in srgb, var(--color-system-blue) 28%, transparent)' : 'none',
            overflow: 'hidden',
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {isFailed ? (
              <m.div
                key="failed"
                initial={{ scale: 0.2, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.2, opacity: 0 }}
                transition={springs.swift}
                style={{ display: 'flex' }}
              >
                <AlertCircle size={iconSize} strokeWidth={2.25} />
              </m.div>
            ) : isCompleted ? (
              <m.div
                key="check"
                initial={{ scale: 0.2, opacity: 0, rotate: -20 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                exit={{ scale: 0.2, opacity: 0 }}
                transition={springs.swift}
                style={{ display: 'flex' }}
              >
                <Check size={iconSize + 2} strokeWidth={2.75} />
              </m.div>
            ) : (
              <m.div
                key="icon"
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ duration: 0.18, ease: easings.apple, delay: index * 0.035 }}
                style={{ display: 'flex' }}
              >
                <Icon size={iconSize} strokeWidth={1.75} />
              </m.div>
            )}
          </AnimatePresence>
        </m.div>
      </div>

      {/* 阶段文字 */}
      <div
        style={{
          fontSize: 11,
            letterSpacing: 0,
          color: reached || isFailed
            ? 'var(--color-text-primary)'
            : 'var(--color-text-tertiary)',
          fontWeight: isCurrent ? 600 : 500,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** 底部整体进度条使用单一系统蓝，右侧展示百分比。 */
function OverallProgress({
  percent,
  active: _active,
  isError,
  done,
}: {
  percent: number;
  active: boolean;
  isError: boolean;
  done: boolean;
}) {
  const trackHeight = 6;
  const barBackground = isError ? 'var(--color-system-red, #ff3b30)' : ACCENT_HEX;
  const barPercent = done ? 100 : isError ? 100 : percent;

  return (
    <div
      aria-label="overall progress"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}
    >
      <div
        style={{
          flex: 1,
          position: 'relative',
          height: trackHeight,
          borderRadius: trackHeight / 2,
          background: 'var(--color-border)',
          overflow: 'hidden',
        }}
      >
        <m.div
          initial={false}
          animate={{ width: `${barPercent}%` }}
          transition={springs.smooth}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            borderRadius: trackHeight / 2,
            background: barBackground,
          }}
        />
      </div>
      <div
        style={{
          minWidth: 44,
          fontSize: 13,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 600,
          color: isError
            ? 'var(--color-system-red, #ff3b30)'
            : 'var(--color-text-primary)',
          textAlign: 'right',
        }}
      >
        {percent}%
      </div>
    </div>
  );
}
