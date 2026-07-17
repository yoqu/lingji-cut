import type { ProjectData } from './project-persistence';
import { detectResumableAutoRun, type ResumableAutoRunInfo } from './auto-run-resume';

const SESSION_DISMISS_KEY_PREFIX = 'auto-run-launcher-dismissed:';

export async function detectLauncherAutoRun(projectDir: string): Promise<
  | { kind: 'none' }
  | ({ kind: 'resumable' } & ResumableAutoRunInfo)
> {
  const api = window.electronAPI;
  if (!api) return { kind: 'none' };
  const [scriptContent, originalContent, projectJson] = await Promise.all([
    api.loadScriptFile(projectDir, 'script.md').catch(() => null),
    api.loadScriptFile(projectDir, 'original.md').catch(() => null),
    api.loadProject(projectDir).catch(() => null),
  ]);
  const project = parseProject(projectJson);
  const detected = detectResumableAutoRun({ scriptContent, originalContent, project });
  const production = project?.production;
  const hasProductionPlan = Boolean(
    production?.draftPlan
    || production?.approvedPlan
    || production?.execution
    || (production && (!production.workflow || production.workflow.stage !== 'idle')),
  );
  if (detected.kind === 'resumable') return { ...detected, hasProductionPlan };
  if (!(scriptContent ?? '').trim() && !(originalContent ?? '').trim()) return detected;
  return {
    kind: 'resumable', restart: true, hasProductionPlan,
    nextStep: 'script_generating', nextStepLabel: '重新生成口播稿',
    persistedAutoParams: project?.workflowMeta?.lastAutoParams ?? null,
  };
}

function parseProject(value: string | null): ProjectData | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ProjectData;
  } catch {
    return null;
  }
}

export function launcherSessionDismissed(projectDir: string): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISS_KEY_PREFIX + projectDir) === '1';
  } catch {
    return false;
  }
}

export function dismissLauncherForSession(projectDir: string): void {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY_PREFIX + projectDir, '1');
  } catch {
    // sessionStorage 可能在受限渲染环境不可用。
  }
}
