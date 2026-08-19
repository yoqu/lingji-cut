import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react';
import { Loader2, ScanSearch } from 'lucide-react';
import { renderBlocks } from '../agent/AssistantMessage';
import type { IngestTraceState } from '../../lib/publish/ingest-trace';
import styles from './IngestTracePanel.module.css';

export function IngestTracePanel({
  trace,
  ingesting,
}: {
  trace: IngestTraceState;
  ingesting: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trace]);

  useEffect(() => {
    pinnedRef.current = true;
  }, [ingesting]);

  return (
    <aside className={styles.panel} data-testid="publish-ingest-trace">
      <div className={styles.head}>
        {ingesting ? <Loader2 size={14} className={styles.spin} /> : <ScanSearch size={14} />}
        <div>
          <h3>识别过程</h3>
          <p>{ingesting ? '正在查看目录与文案…' : '本轮识别记录'}</p>
        </div>
      </div>
      {trace.scanSummary ? (
        <div className={styles.scan}>{trace.scanSummary}</div>
      ) : null}
      <div ref={scrollRef} onScroll={handleScroll} className={styles.body}>
        {trace.blocks.length === 0 && ingesting ? (
          <p className={styles.empty}>扫描完成后会显示思考与工具调用</p>
        ) : null}
        {trace.blocks.length === 0 && !ingesting ? (
          <p className={styles.empty}>重新识别后将在这里展示对话过程</p>
        ) : null}
        {renderBlocks(trace.blocks, {
          isLastAssistant: true,
          isStreaming: ingesting && trace.streaming,
        })}
      </div>
    </aside>
  );
}
