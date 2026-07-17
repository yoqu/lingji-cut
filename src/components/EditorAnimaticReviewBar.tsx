import { Check, Clapperboard, LoaderCircle } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ProjectData } from '../lib/project-persistence';
import type { ProjectProductionState } from '../types/director';
import { Button } from '../ui';
import styles from './EditorAnimaticReviewBar.module.css';

interface EditorAnimaticReviewBarProps {
  projectDir: string;
  onOpenDirector: () => void;
}

async function loadProduction(projectDir: string): Promise<ProjectProductionState | null> {
  const raw = await window.electronAPI.loadProject(projectDir);
  return (JSON.parse(raw) as ProjectData).production ?? null;
}

export function EditorAnimaticReviewBar({
  projectDir,
  onOpenDirector,
}: EditorAnimaticReviewBarProps) {
  const { production, setProduction, loadError } = useAnimaticProduction(projectDir);
  const approval = useAnimaticApproval(projectDir, setProduction);
  if (production?.workflow.stage !== 'animatic-review') return null;
  return (
    <AnimaticReviewContent
      production={production}
      onOpenDirector={onOpenDirector}
      approving={approval.approving}
      error={approval.error ?? loadError}
      onApprove={approval.approve}
    />
  );
}

function useAnimaticProduction(projectDir: string) {
  const [production, setProduction] = useState<ProjectProductionState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setProduction(null);
    setLoadError(null);
    const refresh = () => {
      void loadProduction(projectDir)
        .then((next) => { if (active) setProduction(next); })
        .catch((reason) => {
          if (active) setLoadError(messageOf(reason));
        });
    };
    refresh();
    const unsubscribe = window.electronAPI.onProjectUpdated?.((payload) => {
      if (active && payload.projectPath === projectDir && payload.sections.includes('production')) {
        refresh();
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [projectDir]);
  return { production, setProduction, loadError };
}

function useAnimaticApproval(
  projectDir: string,
  setProduction: Dispatch<SetStateAction<ProjectProductionState | null>>,
) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvingRef = useRef(false);
  const approve = useCallback(async () => {
    if (!projectDir || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    setError(null);
    try {
      setProduction(await window.electronAPI.mutateProjectProduction(projectDir, {
        kind: 'approve-animatic',
        complete: false,
      }));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  }, [projectDir, setProduction]);
  return { approve, approving, error };
}

function AnimaticReviewContent({ production, onOpenDirector, approving, error, onApprove }: {
  production: ProjectProductionState;
  onOpenDirector: () => void;
  approving: boolean;
  error: string | null;
  onApprove: () => Promise<void>;
}) {
  return (
    <div className={styles.bar} role="status" aria-live="polite" data-testid="animatic-review-bar">
      <span className={styles.icon}><Clapperboard size={15} /></span>
      <div className={styles.message}>
        <strong>Animatic 待审</strong>
        <span>
          导演方案 v{production.approvedPlan?.revision ?? '-'}
          {error ? ` · ${error}` : ' · 画面与节奏已准备完成'}
        </span>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={onOpenDirector} disabled={approving}>
          <Clapperboard size={13} />
          返回导演台调整策略
        </Button>
        <Button variant="primary" size="sm" onClick={() => void onApprove()} disabled={approving}>
          {approving ? <LoaderCircle size={13} className={styles.spinner} /> : <Check size={13} />}
          批准 Animatic
        </Button>
      </div>
    </div>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
