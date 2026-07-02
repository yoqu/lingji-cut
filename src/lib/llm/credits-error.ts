/**
 * 灵机剪影网关「积分不足」统一识别与友好化。
 * 网关返回 HTTP 402 + {error:{type:'insufficient_credits',message:'积分余额不足'}}，
 * 各运行时（LLM/图片/TTS/视频）错误串形态不一，这里做单点归一。
 */

export const INSUFFICIENT_CREDITS_MESSAGE =
  '积分不足：账户余额不够本次 AI 消耗，请前往灵机剪影官网充值或兑换后重试';

export function isInsufficientCreditsError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /insufficient_credits|积分余额不足|积分不足/i.test(text);
}

/** 命中积分不足时替换为友好错误，否则原样返回。 */
export function normalizeCreditsError(err: unknown): unknown {
  return isInsufficientCreditsError(err) ? new Error(INSUFFICIENT_CREDITS_MESSAGE) : err;
}
