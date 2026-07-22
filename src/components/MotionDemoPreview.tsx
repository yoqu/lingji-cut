/**
 * MotionDemoPreview —— 单个动效 demo 的实时预览格。
 *
 * 走与生产出卡完全相同的链路：主进程 esbuild 编译产物 → CardHost 求值（require 垫片
 * 绑定宿主 motionKit）→ @remotion/player 播放。懒挂载：进入视口才 mount Player，
 * 离开视口暂停，避免设置页同时常驻 20+ 播放实例。
 */
import { useEffect, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { AbsoluteFill } from 'remotion';
import { CardHost } from '../remotion/card-host';
import type { MotionDemoCard } from '../remotion/motion-kit/demo-cards';
import styles from './MotionDemoPreview.module.css';

function DemoComposition({ compiledJs, cues }: { compiledJs: string; cues: number[] }) {
  return (
    <AbsoluteFill>
      <CardHost overlayId="motion-demo-preview" compiledJs={compiledJs} cues={cues} />
    </AbsoluteFill>
  );
}

interface MotionDemoPreviewProps {
  demo: MotionDemoCard;
  carrierLabel: string;
  /** 主进程编译产物；undefined 表示尚未编译完成 */
  compiledJs?: string;
  loading: boolean;
}

export function MotionDemoPreview({ demo, carrierLabel, compiledJs, loading }: MotionDemoPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // 测试 / 老环境没有 IO 时直接挂载（jsdom 下 Player 不会真正播放）
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setMounted(true);
            playerRef.current?.play();
          } else {
            playerRef.current?.pause();
          }
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ready = Boolean(compiledJs);
  return (
    <div className={styles.card}>
      <div ref={wrapperRef} className={styles.previewBox}>
        {mounted && ready ? (
          <Player
            ref={playerRef}
            component={DemoComposition}
            inputProps={{ compiledJs: compiledJs!, cues: demo.cues }}
            durationInFrames={demo.durationInFrames}
            compositionWidth={960}
            compositionHeight={540}
            fps={30}
            loop
            autoPlay
            acknowledgeRemotionLicense
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div className={styles.placeholder}>{loading ? '编译中…' : '暂无编译产物'}</div>
        )}
      </div>
      <div className={styles.meta}>
        <div className={styles.titleRow}>
          <span className={styles.name}>{demo.primitive}</span>
          <span className={styles.carrier}>{carrierLabel}</span>
        </div>
        <span className={styles.summary}>{demo.summary}</span>
        <span className={styles.hint}>{demo.motionHint}</span>
      </div>
    </div>
  );
}
