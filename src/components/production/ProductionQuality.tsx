import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { MotionProductionPlan } from '../../types/production';
import { Button } from '../../ui';
import styles from './ProductionContent.module.css';

export function ProductionQuality({ plan, onRun }: {
  plan: MotionProductionPlan;
  onRun: () => void;
}) {
  const report = plan.qualityReport;
  return (
    <div className={styles.view}>
      <div className={styles.qualityHeader} data-pass={report?.exportAllowed === true}>
        {report?.exportAllowed ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <strong>{report ? (report.exportAllowed ? '允许质量导出' : '尚未通过制作检查') : '尚未运行制作检查'}</strong>
          <span>{report ? new Date(report.generatedAt).toLocaleString() : '检查镜头、素材、本地化和声音完整度'}</span>
        </div>
      </div>
      <dl className={styles.definitionGrid}>
        <div><dt>Integrated LUFS</dt><dd>{report?.integratedLufs ?? '导出后测量'}</dd></div>
        <div><dt>True Peak</dt><dd>{report?.truePeakDbtp ?? '导出后测量'}</dd></div>
        <div><dt>远程素材</dt><dd>{report?.remoteAssetCount ?? 0}</dd></div>
        <div><dt>问题数量</dt><dd>{report?.issues.length ?? 0}</dd></div>
      </dl>
      {report?.issues.length ? (
        <div className={styles.issueList}>
          {report.issues.map((issue, index) => (
            <div key={`${issue.code}-${index}`} data-severity={issue.severity}>
              <span>{issue.severity === 'error' ? '错误' : '提醒'}</span>
              <p>{issue.message}</p>
            </div>
          ))}
        </div>
      ) : null}
      <Button variant="primary" size="sm" onClick={onRun}>重新运行制作检查</Button>
    </div>
  );
}
