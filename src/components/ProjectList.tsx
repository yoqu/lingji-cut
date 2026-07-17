import { useCallback, useMemo, useState } from 'react';
import { LayoutGrid, List, X } from 'lucide-react';
import { getFileNameFromPath, toFileSrc } from '../lib/utils';
import { PLATFORM_LABEL } from '../lib/publish/platform-labels';
import type { RecentProjectEntry, RecentProjectStage } from '../lib/electron-api';
import { Button, ConfirmDialog } from '../ui';
import styles from './ProjectList.module.css';

interface ProjectListProps {
  projects: RecentProjectEntry[];
  onOpenProject: (projectDir: string) => void;
  onRemoveProject?: (projectDir: string) => void;
}

type ViewMode = 'grid' | 'list';

function formatDate(dateStr: string | number | undefined): string {
  if (!dateStr) return '';
  const date = typeof dateStr === 'string' ? new Date(dateStr) : new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  if (diff < oneDay && date.getDate() === now.getDate()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < oneDay * 2) {
    return '昨天';
  }
  if (diff < oneDay * 7) {
    return date.toLocaleDateString('zh-CN', { weekday: 'short' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

const STAGE_BADGE: Record<RecentProjectStage, { label: string; color: string }> = {
  published: { label: '已发布', color: 'var(--color-success, #22c55e)' },
  editing: { label: '剪辑中', color: 'var(--color-system-blue, #0071e3)' },
  script: { label: '口播稿', color: 'var(--color-warning, #f59e0b)' },
  original: { label: '原稿', color: 'var(--color-warning, #f59e0b)' },
  new: { label: '未开始', color: 'var(--color-text-tertiary, #888)' },
};

function StageBadge({ project }: { project: RecentProjectEntry }) {
  if (!project.stage) return null;
  const config = STAGE_BADGE[project.stage];
  const platforms = (project.publishedPlatforms ?? [])
    .map((p) => PLATFORM_LABEL[p] ?? p)
    .join('、');
  return (
    <span
      title={project.stage === 'published' && platforms ? `已发布：${platforms}` : undefined}
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 500,
        padding: '1px 6px',
        borderRadius: 999,
        background: `color-mix(in srgb, ${config.color} 15%, transparent)`,
        color: config.color,
      }}
    >
      {config.label}
    </span>
  );
}

function PodcastCoverSVG({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 400 225"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="podcastGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1d1d1f" />
          <stop offset="100%" stopColor="#000000" />
        </linearGradient>
        <linearGradient id="micGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#0071e3" />
          <stop offset="100%" stopColor="#005bb5" />
        </linearGradient>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#000000" floodOpacity="0.3" />
        </filter>
      </defs>

      <rect width="400" height="225" fill="url(#podcastGradient)" />

      <g opacity="0.1">
        {[0, 1, 2, 3, 4].map((i) => (
          <circle
            key={i}
            cx={200}
            cy={112}
            r={30 + i * 20}
            fill="none"
            stroke="#0071e3"
            strokeWidth="2"
          />
        ))}
      </g>

      <g filter="url(#shadow)">
        <circle cx="200" cy="112" r="45" fill="#2c2c2e" />
        <circle cx="200" cy="105" r="28" fill="url(#micGradient)" />
        <rect x="192" y="115" width="16" height="30" rx="8" fill="url(#micGradient)" />
        <rect x="180" y="135" width="40" height="4" rx="2" fill="#424245" />
      </g>

      <g opacity="0.6">
        {[-2, -1, 0, 1, 2].map((i, idx) => {
          const heights = [8, 16, 24, 16, 8];
          return (
            <rect
              key={idx}
              x={200 + i * 12 - 2}
              y={170}
              width="4"
              height={heights[idx]}
              rx="2"
              fill="#0071e3"
            />
          );
        })}
      </g>
    </svg>
  );
}

function ProjectCard({
  project,
  onClick,
  onRemove,
}: {
  project: RecentProjectEntry;
  onClick: () => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.coverArea}>
        {project.coverImageUrl ? (
          <img src={toFileSrc(project.coverImageUrl)} alt="" className={styles.coverImage} />
        ) : (
          <PodcastCoverSVG className={styles.coverSVG} />
        )}
      </div>
      <div className={styles.infoArea}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <div className={styles.projectName} title={project.name} style={{ flex: 1, minWidth: 0 }}>
            {project.name}
          </div>
          <StageBadge project={project} />
        </div>
        <div className={styles.projectMeta}>
          <span className={styles.metaItem}>
            创建: {formatDate(project.createdAt)}
          </span>
          <span className={styles.metaItem}>
            更新: {formatDate(project.updatedAt ?? project.lastOpenedAt)}
          </span>
        </div>
        <div className={styles.projectPath} title={project.path}>
          {getFileNameFromPath(project.path)}
        </div>
      </div>
      <Button.Icon
        size="xs"
        variant="ghost"
        className={styles.removeButton}
        onClick={onRemove}
        aria-label="移除项目"
      >
        <X size={12} />
      </Button.Icon>
    </div>
  );
}

function ProjectListItem({
  project,
  onClick,
  onRemove,
}: {
  project: RecentProjectEntry;
  onClick: () => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
  return (
    <div className={styles.listRow} onClick={onClick}>
      <span className={styles.colName} title={project.name}>
        <span className={styles.rowThumb}>
          {project.coverImageUrl ? (
            <img src={toFileSrc(project.coverImageUrl)} alt="" className={styles.rowThumbImg} />
          ) : (
            <PodcastCoverSVG className={styles.rowThumbImg} />
          )}
        </span>
        {project.name}
        <StageBadge project={project} />
      </span>
      <span className={styles.colDate}>
        {formatDate(project.updatedAt ?? project.lastOpenedAt)}
      </span>
      <span className={styles.colPath} title={project.path}>
        {project.path}
      </span>
      <Button.Icon
        size="xs"
        variant="ghost"
        className={styles.listRemoveButton}
        onClick={onRemove}
        aria-label="移除项目"
      >
        <X size={12} />
      </Button.Icon>
    </div>
  );
}

export function ProjectList({ projects, onOpenProject, onRemoveProject }: ProjectListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [pendingRemoval, setPendingRemoval] = useState<RecentProjectEntry | null>(null);

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }, [projects]);

  const handleRemove = useCallback(
    (e: React.MouseEvent, project: RecentProjectEntry) => {
      e.stopPropagation();
      setPendingRemoval(project);
    },
    [],
  );

  if (projects.length === 0) {
    return null;
  }

  return (
    <>
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>本地草稿</div>
          <div className={styles.viewToggle}>
            <Button.Icon
              size="sm"
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              onClick={() => setViewMode('grid')}
              aria-label="网格视图"
            >
              <LayoutGrid size={14} strokeWidth={1.8} />
            </Button.Icon>
            <Button.Icon
              size="sm"
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              onClick={() => setViewMode('list')}
              aria-label="列表视图"
            >
              <List size={14} strokeWidth={1.8} />
            </Button.Icon>
          </div>
        </div>

        {viewMode === 'grid' ? (
          <div className={styles.grid}>
            {sortedProjects.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                onClick={() => onOpenProject(project.path)}
                onRemove={(e) => handleRemove(e, project)}
              />
            ))}
          </div>
        ) : (
          <div className={styles.table}>
            <div className={styles.tableHeader}>
              <span className={styles.colName}>名称</span>
              <span className={styles.colDate}>修改日期</span>
              <span className={styles.colPath}>位置</span>
              <span className={styles.colAction} />
            </div>
            <div className={styles.tableBody}>
              {sortedProjects.map((project) => (
                <ProjectListItem
                  key={project.path}
                  project={project}
                  onClick={() => onOpenProject(project.path)}
                  onRemove={(e) => handleRemove(e, project)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemoval(null);
          }
        }}
        title="从列表移除项目"
        description={
          pendingRemoval
            ? `确认移除「${pendingRemoval.name}」？该操作不会删除本地文件。`
            : undefined
        }
        confirmText="移除"
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!pendingRemoval) {
            return;
          }
          onRemoveProject?.(pendingRemoval.path);
          setPendingRemoval(null);
        }}
      />
    </>
  );
}
