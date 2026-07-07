// tests/skill-cli-consistency.test.ts
// 内置 skill 与 CLI 保持一致：不引用已删除的命令/端点，引用的命令组都存在。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { COMMANDS } from '../cli/src/manifest';
import { readFile } from 'node:fs/promises';

const SKILL_DIR = new URL('../resources/agent-skills/lingji-video-workflow/', import.meta.url);

function skillFiles(): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [
    { name: 'SKILL.md', text: readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8') },
  ];
  for (const f of readdirSync(new URL('references/', SKILL_DIR))) {
    if (f.endsWith('.md')) {
      files.push({ name: `references/${f}`, text: readFileSync(new URL(`references/${f}`, SKILL_DIR), 'utf8') });
    }
  }
  return files;
}

/** 已被移除或替换的表述，出现即为 skill 漂移 */
const FORBIDDEN = [
  'cards gen',
  'cover prompt',
  'cover image',
  'LINGJI_MCP_URL',
  'mcp-endpoint.json',
  '/mcp',
  'MCP 工具',
  '暂时没有 CLI 命令',
];

describe('skill ↔ CLI 一致性', () => {
  it('skill 不引用已删除的命令与旧端点', () => {
    for (const { name, text } of skillFiles()) {
      for (const bad of FORBIDDEN) {
        expect(text.includes(bad), `${name} 含过期表述: ${bad}`).toBe(false);
      }
    }
  });

  it('skill 提到的命令组都在 CLI manifest 中', () => {
    const groups = new Set(COMMANDS.map((c) => c.group));
    const all = skillFiles().map((f) => f.text).join('\n');
    // 扫描 “lingji <group>” 与 “$LINGJI_CLI" <group>” 两种引用形态
    const mentioned = new Set<string>();
    for (const m of all.matchAll(/(?:\$LINGJI_CLI"|lingji)\s+([a-z]+)\b/g)) mentioned.add(m[1]);
    const known = new Set([...groups, 'help', 'edit']);
    const unknown = [...mentioned].filter((g) => !known.has(g));
    expect(unknown).toEqual([]);
  });

  it('SKILL.md version 为 3（触发强制同步）', async () => {
    const text = await readFile(new URL('SKILL.md', SKILL_DIR), 'utf8');
    expect(text).toMatch(/version:\s*3/);
  });
});
