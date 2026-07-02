import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  isInsufficientCreditsError,
  isLingjiGatewayKey,
  normalizeCreditsError,
  normalizeCreditsErrorForKey,
} from '../src/lib/llm/credits-error';

describe('credits-error', () => {
  it('识别网关 402 错误体的各种形态', () => {
    expect(isInsufficientCreditsError(new Error('402 积分余额不足'))).toBe(true);
    expect(
      isInsufficientCreditsError(
        new Error('{"error":{"message":"积分余额不足","type":"insufficient_credits","code":4001}}'),
      ),
    ).toBe(true);
    expect(isInsufficientCreditsError('insufficient_credits')).toBe(true);
    expect(isInsufficientCreditsError(new Error(INSUFFICIENT_CREDITS_MESSAGE))).toBe(true);
  });

  it('不误伤普通错误', () => {
    expect(isInsufficientCreditsError(new Error('网络错误'))).toBe(false);
    expect(isInsufficientCreditsError(new Error('HTTP 500 upstream error'))).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
  });

  it('normalize 命中时替换为友好错误（保留 cause），未命中原样返回', () => {
    const source = new Error('insufficient_credits');
    const hit = normalizeCreditsError(source);
    expect(hit).toBeInstanceOf(Error);
    expect((hit as Error).message).toBe(INSUFFICIENT_CREDITS_MESSAGE);
    expect((hit as Error).cause).toBe(source);

    const original = new Error('别的错误');
    expect(normalizeCreditsError(original)).toBe(original);
  });

  it('生成内容引用"积分不足"字样不再误判（判定收紧为网关特征串）', () => {
    expect(isInsufficientCreditsError(new Error('esbuild: 第 3 行 "积分不足提醒卡片" 编译失败'))).toBe(false);
  });

  it('仅托管 lj_ key 做友好化，自有上游 402 原样透出', () => {
    expect(isLingjiGatewayKey('lj_abc')).toBe(true);
    expect(isLingjiGatewayKey('sk-or-v1-xxx')).toBe(false);
    expect(isLingjiGatewayKey(undefined)).toBe(false);

    const err = new Error('insufficient_credits');
    expect((normalizeCreditsErrorForKey('lj_abc', err) as Error).message).toBe(INSUFFICIENT_CREDITS_MESSAGE);
    expect(normalizeCreditsErrorForKey('sk-or-v1-xxx', err)).toBe(err);
  });
});
