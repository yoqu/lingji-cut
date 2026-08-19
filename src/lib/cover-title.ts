function extractQuotedCoverTitle(prompt: string): string {
  const contextual = prompt.match(
    /(?:画面文字标题|节目标题|主标题|主文案|标题)(?!字体|颜色|字号|字重|排版|位置|描边|阴影|光晕|渐变)\s*(?:文字|文案|内容)?\s*(?:为|是|：|:)?\s*“([^”]{2,40})”/u,
  );
  if (contextual?.[1]?.trim()) return contextual[1].trim();
  return prompt.match(/“([^”]{2,40})”/u)?.[1]?.trim() ?? '';
}

export function resolveCoverPromptTitle(prompt: string): string {
  return extractQuotedCoverTitle(prompt.trim());
}

/** Keep the cover's only visible title identical to the work title. */
export function alignCoverPromptTitle(prompt: string, title: string): string {
  const normalizedTitle = title.trim();
  let normalizedPrompt = prompt.trim();
  if (!normalizedTitle) return normalizedPrompt;
  const exact = `“${normalizedTitle}”`;

  const quotedContext = /((?:画面文字标题|节目标题|主标题|主文案|标题)(?!字体|颜色|字号|字重|排版|位置|描边|阴影|光晕|渐变)\s*(?:文字|文案|内容)?\s*(?:为|是|：|:)?\s*)[“"'][^”"']+[”"']/gu;
  normalizedPrompt = normalizedPrompt.replace(
    quotedContext,
    (_match, prefix: string) => `${prefix}${exact}`,
  );

  const plainContext = /((?:画面文字标题|节目标题|主标题|主文案|标题)(?!字体|颜色|字号|字重|排版|位置|描边|阴影|光晕|渐变)\s*(?:文字|文案|内容)?\s*(?:为|是|：|:)\s*)([^，。；;\n]{2,40})/gu;
  normalizedPrompt = normalizedPrompt.replace(
    plainContext,
    (_match, prefix: string) => `${prefix}${exact}`,
  );

  if (normalizedPrompt.includes(exact)) return normalizedPrompt;
  const direction = `画面唯一文字标题必须逐字呈现为${exact}，不得增删、缩写或改写`;
  return normalizedPrompt ? `${normalizedPrompt}；${direction}。` : direction;
}
