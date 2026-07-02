import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  isInsufficientCreditsError,
  normalizeCreditsError,
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

  it('normalize 命中时替换为友好错误，未命中原样返回', () => {
    const hit = normalizeCreditsError(new Error('insufficient_credits'));
    expect(hit).toBeInstanceOf(Error);
    expect((hit as Error).message).toBe(INSUFFICIENT_CREDITS_MESSAGE);

    const original = new Error('别的错误');
    expect(normalizeCreditsError(original)).toBe(original);
  });
});
