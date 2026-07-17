import { Boxes, Clapperboard, Film, PenLine, Upload } from 'lucide-react';
import { m, LayoutGroup } from 'framer-motion';
import type { AppPage } from '../lib/electron-api';
import { springs } from '../ui/lib/motion';
import { Button } from '../ui';
import styles from './WorkspaceTabs.module.css';
import { useEffect, useState } from 'react';
import type { ProjectData } from '../lib/project-persistence';
import type { DirectorWorkflowStage } from '../types/director';

type WorkspaceTab = 'script-workbench' | 'director-workbench' | 'editor' | 'asset-center' | 'publish';

interface WorkspaceTabsProps {
  active: WorkspaceTab;
  onSwitch: (tab: WorkspaceTab) => void;
  /** script.md 整体进度：null 表示无稿件（隐藏圆环），50 = 已生成未审，100 = 审稿完成 */
  scriptProgress?: number | null;
  projectDir?: string | null;
}

// SVG 进度圆环，r=5 circumference≈31.42
const RING_R = 5;
const RING_C = 2 * Math.PI * RING_R;

function ScriptProgressRing({ progress }: { progress: number }) {
  const done = progress >= 100;
  const dashoffset = RING_C * (1 - progress / 100);
  const color = done ? 'var(--color-success)' : 'var(--color-text-tertiary, #636366)';

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      style={{ flexShrink: 0, transition: 'opacity 0.2s' }}
      aria-label={done ? '写稿已完成' : '写稿进行中'}
    >
      {/* 背景轨道 */}
      <circle
        cx="7"
        cy="7"
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.15"
      />
      {/* 进度弧 */}
      <circle
        cx="7"
        cy="7"
        r={RING_R}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={RING_C}
        strokeDashoffset={dashoffset}
        strokeLinecap="round"
        transform="rotate(-90 7 7)"
        style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease' }}
      />
      {/* 完成勾号 */}
      {done && (
        <polyline
          points="4.5,7 6.2,8.8 9.5,5.5"
          fill="none"
          stroke="var(--color-success)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const tabs: { key: WorkspaceTab; label: string; icon: React.ReactNode; page: AppPage }[] = [
  { key: 'script-workbench', label: '写稿工作台', icon: <PenLine />, page: 'script-workbench' },
  { key: 'director-workbench', label: '导演台', icon: <Clapperboard />, page: 'director-workbench' },
  { key: 'editor', label: '视频编辑器', icon: <Film />, page: 'editor' },
  { key: 'asset-center', label: '资产', icon: <Boxes />, page: 'asset-center' },
  { key: 'publish', label: '发布', icon: <Upload />, page: 'publish' },
];

export function WorkspaceTabs({ active, onSwitch, scriptProgress, projectDir }: WorkspaceTabsProps) {
  const directorStage = useDirectorTabStage(projectDir ?? null);
  return (
    <nav className={styles.root}>
      <LayoutGroup id="workspace-tabs">
        {tabs.map((tab, i) => {
          const isActive = active === tab.key;
          return (
            <span key={tab.key} style={{ display: 'contents' }}>
              {i > 0 && <span className={styles.separator} />}
              <Button
                variant="ghost"
                type="button"
                className={`${styles.tab} ${isActive ? styles.active : ''}`}
                onClick={() => onSwitch(tab.key)}
              >
                {isActive && (
                  <>
                    <m.span
                      layoutId="workspace-tab-bg"
                      className={styles.tabBg}
                      transition={springs.swift}
                    />
                    <m.span
                      layoutId="workspace-tab-underline"
                      className={styles.tabUnderline}
                      transition={springs.swift}
                    />
                  </>
                )}
                <span className={styles.tabContent}>
                  <span className={styles.icon}>{tab.icon}</span>
                  {tab.label}
                  {tab.key === 'script-workbench' && scriptProgress != null && (
                    <ScriptProgressRing progress={scriptProgress} />
                  )}
                  {tab.key === 'director-workbench' && directorStage && (
                    <span
                      className={styles.statusDot}
                      data-state={directorTabState(directorStage)}
                      aria-label={directorTabLabel(directorStage)}
                      title={directorTabLabel(directorStage)}
                    />
                  )}
                </span>
              </Button>
            </span>
          );
        })}
      </LayoutGroup>
    </nav>
  );
}

function useDirectorTabStage(projectDir: string | null): DirectorWorkflowStage | null {
  const [stage, setStage] = useState<DirectorWorkflowStage | null>(null);
  useEffect(() => {
    let active = true;
    setStage(null);
    if (!projectDir || !window.electronAPI) return;
    const refresh = () => void window.electronAPI.loadProject(projectDir)
      .then((raw) => {
        if (active) setStage((JSON.parse(raw) as ProjectData).production?.workflow.stage ?? null);
      })
      .catch(() => undefined);
    refresh();
    const off = window.electronAPI.onProjectUpdated?.((event) => {
      if (event.projectPath === projectDir && event.sections.includes('production')) refresh();
    });
    return () => { active = false; off?.(); };
  }, [projectDir]);
  return stage;
}

function directorTabState(stage: DirectorWorkflowStage): 'active' | 'waiting' | 'error' | 'done' {
  if (stage === 'error' || stage === 'quality-blocked') return 'error';
  if (stage === 'director-review' || stage === 'animatic-review' || stage === 'production-paused') return 'waiting';
  if (stage === 'complete') return 'done';
  return 'active';
}

function directorTabLabel(stage: DirectorWorkflowStage): string {
  if (stage === 'director-review') return '导演方案待批准';
  if (stage === 'animatic-review') return 'Animatic 待确认';
  if (stage === 'production-paused') return '制作已暂停';
  if (stage === 'error' || stage === 'quality-blocked') return '导演台需要处理';
  if (stage === 'complete') return '制作已完成';
  return '导演流程进行中';
}
