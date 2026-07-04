/**
 * motion-storyboard —— 导演产出的结构化分镜（视觉论证设计）契约与机器校验。
 *
 * JSON 分镜换来确定性校验：cue 锚定合法性 / 单调性、信息密度上限、
 * 数字防编造（逐字稿匹配）、载体枚举（结构上排除具象实物）。
 * 校验 error 回喂导演重出，不进入雕刻阶段。
 */

export const STORYBOARD_CARRIERS = [
  'data-hero',
  'comparison',
  'trend',
  'list-build',
  'process',
  'quote',
  'concept',
] as const;
export type StoryboardCarrier = (typeof STORYBOARD_CARRIERS)[number];

export const STORYBOARD_EMPHASES = ['countup-settle', 'slam', 'underline-sweep', 'brighten'] as const;

export type StoryboardBeatKind = 'build' | 'transform' | 'accent';

export interface StoryboardBeat {
  /** 讲出该拍内容的句索引（对应运行时 cues[k]）；第 0 拍可为 null（入场） */
  cue: number | null;
  kind: StoryboardBeatKind;
  /** 新出现的元素及内容；数字 / 专名必须来自逐字稿原文 */
  adds: string;
  /** 已有元素如何变化（保持 / 转化 / 让位 / 弱化）；可省略 */
  changes?: string;
  /** 一句动作意图（不含帧数 / 缓动参数） */
  motion?: string;
}

export interface MotionStoryboard {
  claim: string;
  carrier: StoryboardCarrier;
  scene: string;
  focus?: { beat: number; emphasis?: string };
  beats: StoryboardBeat[];
}

export interface StoryboardValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 模型常见的字段变体归一化：adds/changes/motion 的近义键收敛到契约键名。 */
function normalizeStoryboard(raw: MotionStoryboard): MotionStoryboard {
  if (!raw || !Array.isArray(raw.beats)) return raw;
  const pick = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };
  return {
    ...raw,
    beats: raw.beats.map((beat) => {
      if (!beat || typeof beat !== 'object') return beat;
      const b = beat as unknown as Record<string, unknown>;
      return {
        ...beat,
        adds: pick(b, ['adds', 'add', 'content', 'element', 'elements', 'text']) ?? beat.adds,
        changes: pick(b, ['changes', 'change', 'update', 'updates']) ?? beat.changes,
        motion: pick(b, ['motion', 'action', 'animation']) ?? beat.motion,
      };
    }),
  };
}

/** 从 start 起扫描字符串感知的平衡 {...}，返回闭合下标；未闭合返回 -1。 */
function scanBalanced(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 严格解析失败时修复尾随逗号再试一次（模型最常见的 JSON 语法错）。 */
function tryParseObject(slice: string): Record<string, unknown> | null {
  for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 尝试下一形态 */
    }
  }
  return null;
}

/**
 * 从导演回复中抽取 JSON 分镜：扫描全部平衡 {...} 候选，优先返回含 beats 数组的对象
 * （回复里常混有字段示例等小对象），全部无 beats 时回退首个可解析对象交给校验报缺字段。
 */
export function parseStoryboard(text: string): MotionStoryboard | null {
  const source = (text ?? '').trim();
  let fallback: MotionStoryboard | null = null;
  for (let start = source.indexOf('{'); start >= 0; ) {
    const end = scanBalanced(source, start);
    if (end < 0) break; // 未闭合（截断），后面不会再有完整对象
    const parsed = tryParseObject(source.slice(start, end + 1));
    if (parsed) {
      if (Array.isArray((parsed as { beats?: unknown }).beats)) {
        return normalizeStoryboard(parsed as unknown as MotionStoryboard);
      }
      fallback = fallback ?? (parsed as unknown as MotionStoryboard);
      start = source.indexOf('{', end + 1);
    } else {
      start = source.indexOf('{', start + 1);
    }
  }
  return fallback ? normalizeStoryboard(fallback) : null;
}

/** 解析失败的针对性重出提示：区分 无 JSON / 输出截断 / 语法非法，回喂导演。 */
export function storyboardParseHint(text: string): string {
  const source = (text ?? '').trim();
  const start = source.indexOf('{');
  if (start < 0) {
    return '回复中不含任何 JSON 对象——不要解释、不要提问，直接输出一个 JSON 分镜对象。';
  }
  if (scanBalanced(source, source.lastIndexOf('{')) < 0 && scanBalanced(source, start) < 0) {
    return 'JSON 未闭合，疑似输出被截断——压缩 scene / motion 等文案长度，一次性输出完整 JSON。';
  }
  return 'JSON 语法不合法（常见：单引号、未加引号的键名、注释、尾随逗号）——用严格 JSON 重新输出。';
}

/** 归一化文本用于数字匹配：去掉逗号 / 空格 / 全角逗号，便于 "28,842" ↔ "28842" 互认。 */
function normalizeForNumbers(text: string): string {
  return text.replace(/[,，\s]/g, '');
}

/** 提取需要核对的数字：≥2 位整数或带小数点的数（单位数字噪声大，跳过）。 */
function extractCheckableNumbers(text: string): string[] {
  const normalized = normalizeForNumbers(text);
  return Array.from(normalized.matchAll(/\d+(?:\.\d+)?/g), (m) => m[0]).filter(
    (n) => n.length >= 2 || n.includes('.'),
  );
}

export function validateStoryboard(
  sb: MotionStoryboard | null,
  ctx: { cueCount: number; transcript?: string },
): StoryboardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!sb) {
    return { ok: false, errors: ['无法从回复中解析出 JSON 分镜对象'], warnings };
  }
  if (!sb.claim || typeof sb.claim !== 'string') errors.push('缺少 claim（一句话论点）');
  if (!STORYBOARD_CARRIERS.includes(sb.carrier)) {
    errors.push(`carrier 必须是 ${STORYBOARD_CARRIERS.join(' | ')} 之一，收到 "${String(sb.carrier)}"`);
  }
  if (!sb.scene || typeof sb.scene !== 'string') warnings.push('缺少 scene（终态画面描述）');

  if (!Array.isArray(sb.beats) || sb.beats.length === 0) {
    errors.push('beats 必须是非空数组');
    return { ok: false, errors, warnings };
  }
  if (sb.beats.length > 6) errors.push(`beats 数量 ${sb.beats.length} 超过上限 6（信息密度约束）`);

  let lastCue = -1;
  sb.beats.forEach((beat, i) => {
    if (!beat || typeof beat !== 'object') {
      errors.push(`拍 ${i} 不是对象`);
      return;
    }
    if (!beat.adds || typeof beat.adds !== 'string') {
      errors.push(`拍 ${i} 缺少 adds（新出现的元素及内容）`);
    }
    if (beat.kind && !['build', 'transform', 'accent'].includes(beat.kind)) {
      warnings.push(`拍 ${i} 的 kind "${String(beat.kind)}" 不在 build|transform|accent 中`);
    }
    const cue = beat.cue;
    if (cue == null) {
      if (i > 0) errors.push(`拍 ${i} 的 cue 为空；只有第 0 拍（入场）允许 cue 为 null`);
      return;
    }
    if (!Number.isInteger(cue) || cue < 0) {
      errors.push(`拍 ${i} 的 cue=${String(cue)} 不是合法句索引`);
      return;
    }
    if (ctx.cueCount > 0 && cue >= ctx.cueCount) {
      errors.push(`拍 ${i} 的 cue=${cue} 越界（本段只有 ${ctx.cueCount} 句，合法范围 0-${ctx.cueCount - 1}）`);
    }
    if (cue < lastCue) {
      errors.push(`拍 ${i} 的 cue=${cue} 小于前一拍的 ${lastCue}；cue 必须随拍序单调不减（跟随口播顺序）`);
    }
    lastCue = Math.max(lastCue, cue);
  });

  if (sb.focus) {
    if (!Number.isInteger(sb.focus.beat) || sb.focus.beat < 0 || sb.focus.beat >= sb.beats.length) {
      errors.push(`focus.beat=${String(sb.focus.beat)} 不是合法拍索引（0-${sb.beats.length - 1}）`);
    }
    if (sb.focus.emphasis && !(STORYBOARD_EMPHASES as readonly string[]).includes(sb.focus.emphasis)) {
      warnings.push(`focus.emphasis "${sb.focus.emphasis}" 不在 ${STORYBOARD_EMPHASES.join('|')} 中，将按 settle 处理`);
    }
  } else {
    warnings.push('未标注 focus（唯一语义焦点所在拍）');
  }

  // 数字防编造：分镜里的数字必须能在逐字稿中找到。
  const transcript = normalizeForNumbers(ctx.transcript ?? '');
  if (transcript) {
    const fabricated = new Set<string>();
    for (const beat of sb.beats) {
      const text = `${beat?.adds ?? ''} ${beat?.changes ?? ''}`;
      for (const num of extractCheckableNumbers(text)) {
        if (!transcript.includes(num)) fabricated.add(num);
      }
    }
    if (fabricated.size > 0) {
      errors.push(
        `分镜中的数字 [${Array.from(fabricated).join(', ')}] 在本段逐字稿中不存在；数据必须忠于口播原文，不得编造 / 换算 / 四舍五入`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 把校验问题格式化为回喂导演的重出指令。 */
export function formatStoryboardIssues(validation: StoryboardValidation): string {
  const lines = validation.errors.map((e, i) => `${i + 1}. ${e}`);
  return lines.join('\n');
}
