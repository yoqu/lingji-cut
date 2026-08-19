import { describe, expect, it } from 'vitest';
import {
  buildMotionCardProductionReport,
  determineMotionCardQualityStatus,
} from '../src/lib/motion-production-report';

describe('motion production report', () => {
  it('无问题时为 pass，并保留生成元信息', () => {
    const report = buildMotionCardProductionReport({
      generatedAt: 123,
      framesChecked: [0, 75, 149],
    });
    expect(report.status).toBe('pass');
    expect(report.generatedAt).toBe(123);
    expect(report.framesChecked).toEqual([0, 75, 149]);
    expect(report.renderOk).toBe(true);
    expect(report.assetIssues).toEqual([]);
  });

  it('资产问题参与质量评级并保留资产来源', () => {
    const report = buildMotionCardProductionReport({
      assetIssues: [{
        severity: 'error',
        code: 'asset-alpha-missing',
        message: '前景物件没有透明通道',
      }],
    });

    expect(report.status).toBe('risk');
    expect(report.assetIssues[0]).toMatchObject({
      severity: 'error',
      source: 'asset',
      code: 'asset-alpha-missing',
    });
  });

  it('warning 映射为 acceptable，error 映射为 risk', () => {
    expect(
      buildMotionCardProductionReport({
        lintIssues: [{ severity: 'warn', code: 'cues-unused', message: '未使用 cues' }],
      }).status,
    ).toBe('acceptable');

    expect(
      buildMotionCardProductionReport({
        layoutIssues: [{ severity: 'error', code: 'subtitle-zone', message: '侵入字幕区' }],
      }).status,
    ).toBe('risk');
  });

  it('fallback 和 render 失败有最高优先级', () => {
    expect(
      determineMotionCardQualityStatus({
        fallbackUsed: true,
        lintIssues: [{ severity: 'warning', source: 'lint', message: 'warn' }],
      }),
    ).toBe('fallback');

    expect(
      determineMotionCardQualityStatus({
        renderOk: false,
        fallbackUsed: true,
      }),
    ).toBe('failed');
  });

  it('review issue 会归一化为 production issue', () => {
    const report = buildMotionCardProductionReport({
      reviewIssues: [{
        severity: 'error',
        element: '拍2',
        rule: '焦点层级',
        fix: '放大主数字',
        frame: 94,
        beat: 2,
        visualProblem: '主数字被次级列表抢戏',
      }],
    });
    expect(report.reviewIssues[0]).toMatchObject({
      severity: 'error',
      source: 'review',
      message: '放大主数字',
      element: '拍2',
      rule: '焦点层级',
      frame: 94,
      beat: 2,
      visualProblem: '主数字被次级列表抢戏',
    });
  });

  it('keeps contact sheet cache metadata', () => {
    const report = buildMotionCardProductionReport({
      contactSheetPath: '/tmp/sheet.png',
      contactSheetCacheKey: 'abc',
      contactSheetCached: true,
    });
    expect(report.contactSheetPath).toBe('/tmp/sheet.png');
    expect(report.contactSheetCacheKey).toBe('abc');
    expect(report.contactSheetCached).toBe(true);
  });

  it('unavailableReason 会强制视觉审片状态为不可用并保留具体原因', () => {
    const report = buildMotionCardProductionReport({
      visualReviewAvailable: true,
      unavailableReason: ' reviewer 无法读取 contact sheet。 ',
    });
    expect(report.visualReviewAvailable).toBe(false);
    expect(report.unavailableReason).toBe('reviewer 无法读取 contact sheet。');
  });
});
