import { ChevronDown, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useScriptStore } from '../../store/script';
import { Badge, Popover, PopoverContent, PopoverTrigger } from '../../ui';
import styles from './VersionDropdown.module.css';

type VersionMeta = {
  id: number;
  fileName: string;
  source: string;
  providerName: string | null;
  modelName: string | null;
  label: string | null;
  byteSize: number;
  createdAt: string;
};

type FilterTab = '全部' | '仅AI' | '仅手动';

/** 格式化时间 */
function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

/** 版本历史下拉面板（仅在 openedFile === 'script.md' 时显示） */
export function VersionDropdown() {
  const openedFile = useScriptStore((s) => s.openedFile);
  const projectDir = useScriptStore((s) => s.projectDir);
  const enterHistoryPreview = useScriptStore((s) => s.enterHistoryPreview);
  const shouldRender = openedFile === 'script.md';

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('全部');
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(false);

  const loadVersions = async () => {
    if (!projectDir || typeof window === 'undefined' || !window.scriptHistoryAPI) return;
    setLoading(true);
    try {
      const list = await window.scriptHistoryAPI.list(projectDir, 'script.md', { limit: 50 });
      setVersions(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadVersions();
    }
  }, [open]);

  const handleSelectVersion = async (v: VersionMeta) => {
    if (!projectDir) return;
    const detail = await window.scriptHistoryAPI.get(projectDir, v.id);
    if (!detail) return;
    enterHistoryPreview(v.id, detail.content, {
      id: v.id,
      fileName: v.fileName,
      source: v.source,
      providerName: v.providerName,
      modelName: v.modelName,
      label: v.label,
      byteSize: v.byteSize,
      createdAt: v.createdAt,
    });
    setOpen(false);
  };

  const filteredVersions = versions.filter((v) => {
    if (filter === '仅AI') return v.source === 'ai';
    if (filter === '仅手动') return v.source !== 'ai';
    return true;
  });

  const filterTabs: FilterTab[] = ['全部', '仅AI', '仅手动'];

  if (!shouldRender) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-open={open}
          aria-label="查看历史版本"
        >
          <Clock className={styles.icon} />
          历史版本
          <ChevronDown className={styles.chevron} />
        </button>
      </PopoverTrigger>

      <PopoverContent side="bottom" align="end" sideOffset={6} className={`w-[340px] p-0 ${styles.panel}`}>
        <div className={styles.filterBar}>
          {filterTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={styles.filterTab}
              data-active={filter === tab}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className={styles.list}>
          {loading ? (
            <div className={styles.empty}>加载中…</div>
          ) : filteredVersions.length === 0 ? (
            <div className={styles.empty}>暂无版本记录</div>
          ) : (
            filteredVersions.map((v, idx) => {
              const isAI = v.source === 'ai';
              const sourceLabel = isAI ? 'AI 生成' : '手动保存';
              const sourceKey = isAI ? 'ai' : 'manual';

              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => void handleSelectVersion(v)}
                  className={styles.versionItem}
                >
                  <span className={styles.bar} data-source={sourceKey} />

                  <div className={styles.versionContent}>
                    <div className={styles.versionRow1}>
                      <span className={styles.sourceTag} data-source={sourceKey}>
                        {sourceLabel}
                      </span>
                      <span className={styles.timeLabel}>
                        {formatTime(v.createdAt)}
                      </span>
                      {idx === 0 && (
                        <span className={styles.currentBadge}>当前</span>
                      )}
                    </div>

                    <div className={styles.versionRow2}>
                      {v.providerName && (
                        <Badge color="var(--color-system-blue)" size="xs">
                          {v.providerName}
                          {v.modelName ? ` / ${v.modelName}` : ''}
                        </Badge>
                      )}
                      {v.label && (
                        <span className={styles.versionLabel}>
                          「{v.label}」
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
