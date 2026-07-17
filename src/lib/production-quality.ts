import type { ProjectData } from './project-persistence';
import type { TimelineData } from '../types';
import type { ProductionQualityIssue, ProductionQualityReport } from '../types/production';

function remoteAssetIssues(timeline: TimelineData): ProductionQualityIssue[] {
  const paths = [timeline.podcast.audioPath, ...timeline.overlays.map((overlay) => overlay.assetPath)];
  return paths
    .filter((assetPath) => /^https?:\/\//iu.test(assetPath))
    .map((assetPath) => ({
      severity: 'error' as const,
      source: 'asset' as const,
      code: 'remote-asset',
      message: `质量导出前必须本地化远程素材：${assetPath}`,
    }));
}

function audioPlanIssues(project: ProjectData, timeline: TimelineData): ProductionQualityIssue[] {
  const plan = project.production?.execution?.audioPlan;
  if (!plan) return [];
  const locallyPlacedCueIds = new Set(
    timeline.overlays.flatMap((overlay) => {
      const cueId = overlay.audioData?.cueId;
      return overlay.type === 'audio'
        && cueId
        && overlay.assetPath
        && !/^https?:\/\//iu.test(overlay.assetPath)
        ? [cueId]
        : [];
    }),
  );
  const issues: ProductionQualityIssue[] = [...plan.bgm, ...plan.ambience, ...plan.stingers, ...plan.sfx]
    .filter((cue) => cue.required && !cue.assetId && !locallyPlacedCueIds.has(cue.id))
    .map((cue) => ({
      severity: 'error' as const,
      source: 'audio' as const,
      code: 'required-audio-missing',
      message: `必需声音尚未解析到本地素材：${cue.query}`,
      cueId: cue.id,
    }));
  const durationMs = timeline.podcast.durationMs
    || plan.bgm[0]?.durationMs
    || Math.max(0, ...(project.production?.execution?.shots ?? []).map((shot) => shot.endMs));
  const accentCueCount = plan.stingers.length + plan.sfx.length;
  if (durationMs >= 30_000 && accentCueCount > 0) {
    const cuesPerMinute = accentCueCount / (durationMs / 60_000);
    if (cuesPerMinute > 4) {
      issues.push({
        severity: 'warning',
        source: 'audio',
        code: 'audio-cue-density-high',
        message: `章节与重点声音密度 ${cuesPerMinute.toFixed(1)} 次/分钟，建议控制在 2–4 次/分钟`,
      });
    }
  }
  return issues;
}

function visualIssues(project: ProjectData): ProductionQualityIssue[] {
  const cards = project.aiAnalysis.analysisResult?.cards ?? [];
  return cards.flatMap((card) => {
    const report = card.motionCard?.productionReport;
    const issues: ProductionQualityIssue[] = [];
    const content = card.content;
    const media = content && typeof content === 'object' && 'mediaType' in content ? content : null;
    if (media && (media.generationStatus !== 'ready' || !media.assetPath)) {
      issues.push({
        severity: 'error', source: 'asset', code: 'shot-asset-missing',
        message: `镜头素材尚未生成或匹配：${card.title}`, shotId: card.id,
      });
    }
    if (!report) {
      issues.push({
        severity: 'warning', source: 'visual', code: 'visual-review-pending',
        message: `镜头尚未生成视觉审片报告：${card.title}`, shotId: card.id,
      });
      return issues;
    }
    if (!report.renderOk || report.status === 'failed') {
      issues.push({
        severity: 'error',
        source: 'visual',
        code: 'shot-render-failed',
        message: `镜头未通过渲染质检：${card.title}`,
        shotId: card.id,
      });
    } else if (report.status === 'risk' || report.fallbackUsed) {
      issues.push({
        severity: 'warning',
        source: 'visual',
        code: report.fallbackUsed ? 'shot-fallback' : 'shot-risk',
        message: `镜头需要人工复核：${card.title}`,
        shotId: card.id,
      });
    }
    if (report.visualReviewAvailable === false) {
      issues.push({
        severity: 'warning',
        source: 'visual',
        code: 'visual-review-unavailable',
        message: `镜头未完成多模态审片：${card.title}`,
        shotId: card.id,
      });
    }
    return issues;
  });
}

export function evaluateProductionQuality(
  project: ProjectData,
  timeline: TimelineData,
  audioMeasurement?: { integratedLufs: number; truePeakDbtp: number },
): ProductionQualityReport {
  const issues: ProductionQualityIssue[] = [
    ...remoteAssetIssues(timeline),
    ...audioPlanIssues(project, timeline),
    ...visualIssues(project),
  ];
  const mastering = project.production?.execution?.audioPlan.mastering;
  if (audioMeasurement && mastering) {
    if (Math.abs(audioMeasurement.integratedLufs - mastering.targetLufs) > mastering.toleranceLu) {
      issues.push({
        severity: 'error',
        source: 'audio',
        code: 'master-loudness-out-of-range',
        message: `成片响度 ${audioMeasurement.integratedLufs.toFixed(1)} LUFS 超出目标 ${mastering.targetLufs} ±${mastering.toleranceLu} LU`,
      });
    }
    if (audioMeasurement.truePeakDbtp > mastering.maxTruePeakDbtp) {
      issues.push({
        severity: 'error',
        source: 'audio',
        code: 'master-true-peak-exceeded',
        message: `成片 True Peak ${audioMeasurement.truePeakDbtp.toFixed(1)} dBTP 超过 ${mastering.maxTruePeakDbtp} dBTP`,
      });
    }
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    generatedAt: Date.now(),
    exportAllowed: errorCount === 0,
    degraded: issues.length > 0,
    integratedLufs: audioMeasurement?.integratedLufs,
    truePeakDbtp: audioMeasurement?.truePeakDbtp,
    remoteAssetCount: issues.filter((issue) => issue.code === 'remote-asset').length,
    issues,
  };
}
