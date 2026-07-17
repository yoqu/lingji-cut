export interface VisualAuthenticityContext {
  title?: string;
  summary?: string;
  transcriptExcerpt?: string;
  keywords?: string[];
  entities?: string[];
}

const VERIFIED_FOOTAGE_PATTERNS = [
  /上市敲钟|敲钟(?:仪式|现场)?/,
  /(?:登陆|挂牌)(?:香港联交所|港交所|上交所|深交所|北交所|纽交所|纳斯达克)/,
  /(?:上市|挂牌)(?:仪式|现场|首日)/,
  /正式上市|公司上市|企业上市|港股上市|A股上市|美股上市|上市(?:成功|完成|标志|挂牌|交易)/i,
  /IPO(?:敲钟|上市|挂牌)/i,
  /(?:新闻|新品)?发布会/,
  /签约(?:仪式|现场)/,
  /庭审(?:现场|开庭)|开庭现场/,
  /(?:事故|灾害|救援|爆炸|火灾|地震|洪水)现场/,
  /记者会|采访现场|颁奖(?:典礼|现场)|开幕式|闭幕式/,
  /(?:峰会|会议|会见)现场/,
] as const;

/** 这些现实事件必须用可核验真实素材或 Motion 表达，不能进入写实 AI 图片卡链路。 */
export function requiresVerifiedRealFootage(context: VisualAuthenticityContext): boolean {
  const text = [
    context.title,
    context.summary,
    context.transcriptExcerpt,
    ...(context.keywords ?? []),
    ...(context.entities ?? []),
  ]
    .filter(Boolean)
    .join(' ');
  return VERIFIED_FOOTAGE_PATTERNS.some((pattern) => pattern.test(text));
}
