import type {
  MotionCardProductionIssue,
  MotionCardProductionIssueSource,
  MotionCardProductionReport,
  MotionCardQualityStatus,
} from '../types/motion';

type RawSeverity = 'error' | 'warning' | 'warn' | string | undefined;

export interface RawProductionIssue {
  severity?: RawSeverity;
  code?: string;
  message?: string;
  element?: string;
  rule?: string;
  fix?: string;
  frame?: number;
  beat?: number;
  visualProblem?: string;
}

export interface BuildMotionCardProductionReportInput {
  generatedAt?: number;
  framesChecked?: number[];
  lintIssues?: RawProductionIssue[];
  layoutIssues?: RawProductionIssue[];
  reviewIssues?: RawProductionIssue[];
  assetIssues?: RawProductionIssue[];
  fallbackUsed?: boolean;
  /** true = storyboard 确定性模板编译产物（template 模式主路径）。 */
  compiled?: boolean;
  fixRounds?: number;
  reviewRounds?: number;
  renderOk?: boolean;
  visualReviewAvailable?: boolean;
  unavailableReason?: string;
  contactSheetPath?: string;
  contactSheetCacheKey?: string;
  contactSheetCached?: boolean;
  contactSheetError?: string;
}

function normalizeSeverity(severity: RawSeverity): 'error' | 'warning' {
  return severity === 'error' ? 'error' : 'warning';
}

function normalizeIssue(
  issue: RawProductionIssue,
  source: MotionCardProductionIssueSource,
): MotionCardProductionIssue {
  return {
    severity: normalizeSeverity(issue.severity),
    source,
    code: issue.code,
    message: issue.message?.trim() || issue.fix?.trim() || issue.rule?.trim() || '未提供问题描述',
    element: issue.element,
    rule: issue.rule,
    fix: issue.fix,
    frame: issue.frame,
    beat: issue.beat,
    visualProblem: issue.visualProblem,
  };
}

function hasError(issues: MotionCardProductionIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function determineMotionCardQualityStatus(input: {
  renderOk?: boolean;
  fallbackUsed?: boolean;
  lintIssues?: MotionCardProductionIssue[];
  layoutIssues?: MotionCardProductionIssue[];
  reviewIssues?: MotionCardProductionIssue[];
  assetIssues?: MotionCardProductionIssue[];
}): MotionCardQualityStatus {
  if (input.renderOk === false) return 'failed';
  if (input.fallbackUsed) return 'fallback';

  const issues = [
    ...(input.lintIssues ?? []),
    ...(input.layoutIssues ?? []),
    ...(input.reviewIssues ?? []),
    ...(input.assetIssues ?? []),
  ];
  if (hasError(issues)) return 'risk';
  if (issues.length > 0) return 'acceptable';
  return 'pass';
}

export function buildMotionCardProductionReport(
  input: BuildMotionCardProductionReportInput = {},
): MotionCardProductionReport {
  const lintIssues = (input.lintIssues ?? []).map((issue) => normalizeIssue(issue, 'lint'));
  const layoutIssues = (input.layoutIssues ?? []).map((issue) => normalizeIssue(issue, 'layout'));
  const reviewIssues = (input.reviewIssues ?? []).map((issue) => normalizeIssue(issue, 'review'));
  const assetIssues = (input.assetIssues ?? []).map((issue) => normalizeIssue(issue, 'asset'));
  const renderOk = input.renderOk !== false;
  const fallbackUsed = input.fallbackUsed === true;

  return {
    status: determineMotionCardQualityStatus({
      renderOk,
      fallbackUsed,
      lintIssues,
      layoutIssues,
      reviewIssues,
      assetIssues,
    }),
    generatedAt: input.generatedAt ?? Date.now(),
    framesChecked: [...(input.framesChecked ?? [])],
    lintIssues,
    layoutIssues,
    reviewIssues,
    assetIssues,
    fallbackUsed,
    ...(input.compiled ? { compiled: true } : {}),
    fixRounds: Math.max(0, Math.round(input.fixRounds ?? 0)),
    reviewRounds: Math.max(0, Math.round(input.reviewRounds ?? 0)),
    renderOk,
    visualReviewAvailable: input.visualReviewAvailable,
    unavailableReason: input.unavailableReason,
    contactSheetPath: input.contactSheetPath,
    contactSheetCacheKey: input.contactSheetCacheKey,
    contactSheetCached: input.contactSheetCached,
    contactSheetError: input.contactSheetError,
  };
}
