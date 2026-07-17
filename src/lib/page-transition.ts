import type { AppPage } from './electron-api';
import type { TargetAndTransition, Transition } from 'framer-motion';

export type PageTransitionReason = 'default' | 'close-project';

interface ResolvePageTransitionOptions {
  fromPage: AppPage;
  toPage: AppPage;
  reason: PageTransitionReason;
  reducedMotion: boolean;
}

export interface PageTransitionConfig {
  enabled: boolean;
  contentKey: string;
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

const STATIC_STATE: TargetAndTransition = { opacity: 1, y: 0 };
// Apple easeOutExpo
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];
// Apple default(稍快)
const EASE_APPLE: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

/**
 * 工作区三个 tab：写稿工作台 / 视频编辑器 / 发布。
 * 它们共用同一棵子树（App.tsx 里用 display:contents/none 切换显隐），切换时
 * 必须共用稳定的 contentKey，避免 AnimatePresence 触发 exit→remount。
 */
const WORKSPACE_PAGES: ReadonlySet<AppPage> = new Set([
  'script-workbench',
  'director-workbench',
  'editor',
  'asset-center',
  'publish',
]);

/**
 * 页面过渡配置 — macOS 风格:
 * - 工作区内部（写稿/编辑器/发布）切换走稳定 contentKey + CSS display，零振荡、不 remount
 * - 所有进入 welcome/setup 的路径:淡出回 welcome 用 y:8 柔和落下
 * - 所有进入 settings 的路径:淡入 + 轻微 y 偏移(侧栏感)
 * - 默认:普通 crossfade(短促淡入淡出)
 */
export function resolvePageTransition({
  fromPage,
  toPage,
  reason,
  reducedMotion,
}: ResolvePageTransitionOptions): PageTransitionConfig {
  if (reducedMotion) {
    return {
      enabled: false,
      contentKey: 'static-content',
      initial: STATIC_STATE,
      animate: STATIC_STATE,
      exit: STATIC_STATE,
      transition: { duration: 0, ease: EASE_APPLE },
    };
  }

  // 工作区内部三页（写稿/编辑器/发布）切换：共用稳定 contentKey，让
  // AnimatePresence 不介入。App.tsx 里这三页同属一棵子树，用 display 切换显隐，
  // 切换走 CSS 而非 exit→remount，避免 framer-motion v12 在
  // exit 动画与新 render 时序竞态下卡在「旧节点 opacity:0、新节点永不挂载」的空白态。
  // 历史上这里曾用 `crossfade:editor->script-workbench` 这种变化 key，触发空白。
  if (WORKSPACE_PAGES.has(toPage) && WORKSPACE_PAGES.has(fromPage)) {
    return {
      enabled: false,
      contentKey: 'workspace',
      initial: STATIC_STATE,
      animate: STATIC_STATE,
      // 工作区内部切换走稳定 key，这份 exit 永不在 tab 互切时触发（元素不卸载）。
      // 它只在「离开工作区」时被 AnimatePresence 冻结使用（如 publish/editor → settings）。
      // 必须是真正改变 opacity 的动画：no-op exit（opacity 不变）在 framer-motion v12
      // 的退出时序下容易让旧节点留在空白态，影响目标页（Settings）显示。
      exit: { opacity: 0 },
      transition: { duration: 0.18, ease: EASE_APPLE },
    };
  }

  // close-project 回 welcome:强调柔和落下
  if (reason === 'close-project' && toPage === 'welcome') {
    return {
      enabled: true,
      contentKey: `close-project:${fromPage}->${toPage}`,
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: 10 },
      transition: { duration: 0.26, ease: EASE_OUT_EXPO },
    };
  }

  // 进入 settings 页:模拟 sheet 从顶滑入感(轻微)
  if (toPage === 'settings') {
    return {
      enabled: true,
      contentKey: `to-settings:${fromPage}`,
      initial: { opacity: 0, y: -6 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -4 },
      transition: { duration: 0.22, ease: EASE_APPLE },
    };
  }

  // 默认 crossfade(所有其余页面切换)
  return {
    enabled: true,
    contentKey: `crossfade:${fromPage}->${toPage}`,
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.18, ease: EASE_APPLE },
  };
}
