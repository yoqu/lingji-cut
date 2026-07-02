/**
 * 灵机剪影网关「积分不足」统一识别与友好化。
 * 网关返回 HTTP 402 + {error:{type:'insufficient_credits',message:'积分余额不足'}}，
 * 各运行时（LLM/图片/TTS/视频）错误串形态不一，这里做单点归一。
 *
 * 判定收紧为网关特征串（insufficient_credits / 积分余额不足），避免 parse/validate
 * 报错引用了含"积分不足"字样的生成内容时被误判并跳过重试。
 */

export const INSUFFICIENT_CREDITS_MESSAGE =
  '积分不足：账户余额不够本次 AI 消耗，请前往灵机剪影官网充值或兑换后重试';

export function isInsufficientCreditsError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /insufficient_credits|积分余额不足/i.test(text) || text === INSUFFICIENT_CREDITS_MESSAGE;
}

/** 命中积分不足时替换为友好错误（保留 cause），否则原样返回。 */
export function normalizeCreditsError(err: unknown): unknown {
  if (!isInsufficientCreditsError(err)) return err;
  const friendly = new Error(INSUFFICIENT_CREDITS_MESSAGE);
  (friendly as Error & { cause?: unknown }).cause = err;
  return friendly;
}

/**
 * 是否灵机网关密钥（lj_ 前缀）。友好化只对托管调用生效，
 * 避免把用户自有上游（如 OpenRouter 402）误导去灵机官网充值。
 */
export function isLingjiGatewayKey(apiKey: string | null | undefined): boolean {
  return typeof apiKey === 'string' && apiKey.startsWith('lj_');
}

/** 仅当调用使用灵机网关密钥时做积分不足友好化。 */
export function normalizeCreditsErrorForKey(apiKey: string | null | undefined, err: unknown): unknown {
  return isLingjiGatewayKey(apiKey) ? normalizeCreditsError(err) : err;
}
