import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * file-first 编辑契约块的包裹 marker。
 * 与 MCP 指引的 `<!-- lingji-mcp-instructions -->` 不同，互不覆盖。
 * 采用「成对包裹」（open + close）写法，使多个块可在同一文件共存。
 */
export const FILE_FIRST_MARKER = '<!-- lingji-file-first-contract -->';

const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按 marker 成对包裹 block：
 * - 读文件（不存在当空串）
 * - 用 marker 包裹 block（开头 + 结尾各一个 marker）
 * - 若已存在 marker 对则正则替换，否则追加到文件末尾
 * - 写回
 *
 * 只依赖 node:fs/promises + node:path，无 electron 依赖，便于在 vitest(node) 中测试。
 */
export async function upsertContractBlock(
  filePath: string,
  marker: string,
  block: string,
): Promise<void> {
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // 文件不存在 → 当空串处理
  }

  const wrapped = `${marker}\n${block.trim()}\n${marker}`;
  const m = escapeRegExp(marker);
  // 匹配一对 marker 之间的内容（含 marker 本身），跨行、非贪婪
  const pairRe = new RegExp(`${m}[\\s\\S]*?${m}`);

  let next: string;
  if (pairRe.test(content)) {
    next = content.replace(pairRe, wrapped);
  } else {
    next = content.trim() ? `${content.trimEnd()}\n\n${wrapped}\n` : `${wrapped}\n`;
  }

  await fs.writeFile(filePath, next, 'utf-8');
}

/**
 * 构建 file-first 编辑契约要点的 markdown（中文）。
 * 详细规则指向项目内 docs/ai-contract/。
 */
export function buildFileFirstContractBlock(): string {
  return `## 灵机剪影 · AI File-First 编辑契约

你可以**直接编辑本项目目录下的文件**来修改视频与文稿，编辑器会实时热重载预览，无需调用任何 App 内工具。

### 锁协议
- 编辑前执行 \`node "$LINGJI_CLI" edit lock --project <projectDir> --scope video|script --reason "<说明>" --json\`，由应用锁定内容界面并写出兼容锁文件。
- 长任务每约 60s 执行 \`node "$LINGJI_CLI" edit heartbeat --project <projectDir> --json\`。
- 编辑完成后执行 \`node "$LINGJI_CLI" edit unlock --project <projectDir> --json\`。

### 结果协议
- 修改 \`project.json\` 后，读取 \`.lingji/edit-result.json\`（\`{ ok, errors }\`）自查校验结果。
- 无需调用任何 MCP 工具，文件即接口。

### 能力域
- **视频**：编辑 \`project.json\` 的 \`timeline\` 段，以及 \`ai-cards/<id>/motionCard.tsx\`（Motion Card 动画源码）。详见 \`docs/ai-contract/video-editing.md\`。
- **文稿**：编辑 \`script.md\`（口播成稿）与 \`original.md\`（原始素材）。详见 \`docs/ai-contract/script-editing.md\`。
- 总纲见 \`docs/ai-contract/README.md\`。

### 边界
- 仅做纯编辑。**不要**触发重新生成、重新导出、TTS 配音或 AI 画图。

### 可用内置工作流

本应用提供内置 \`$lingji-video-workflow\`。当用户希望从稿件推进到灵机剪影视频，或需要协调文稿、生成、时间线、Motion Card 精修时，优先使用该 workflow。用户也可以在对话中显式输入 \`$lingji-video-workflow\`。`;
}

/**
 * 对项目目录下的 CLAUDE.md / AGENTS.md / GEMINI.md 逐个写入 file-first 契约块。
 * 每个文件独立 try/catch，单个失败仅 warn，不中断其余文件。
 */
export async function ensureProjectAgentContracts(projectDir: string): Promise<void> {
  const block = buildFileFirstContractBlock();
  for (const name of AGENT_FILES) {
    const filePath = path.join(projectDir, name);
    try {
      await upsertContractBlock(filePath, FILE_FIRST_MARKER, block);
    } catch (err) {
      console.warn(`[ACP] 写入 ${name} file-first 契约失败:`, err);
    }
  }
}
