/**
 * pi-agents-seed.ts
 *
 * Pi agent 角色定义（card-director / card-sculptor / card-reviewer / show-director / publish-ingest）的
 * 种子播种与读取：种子在应用资源 resources/pi-agents/agents，运行时按 frontmatter
 * version 强制同步到 ~/.lingji/pi-agent/agents（版本变更即覆盖；用户可在目标目录
 * 微调正文，但升级种子版本会重置——与 agent-skills 的 version 强制同步语义一致）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const PI_AGENT_ROLE_NAMES = ['card-director', 'card-sculptor', 'card-reviewer', 'show-director', 'publish-ingest'] as const;
export type PiAgentRoleName = (typeof PI_AGENT_ROLE_NAMES)[number];

export interface PiAgentRole {
  name: string;
  version: string;
  tools: string[];
  /** frontmatter 之后的正文，作为该角色会话的 system prompt。 */
  systemPrompt: string;
}

/** 目标目录：与 pi 会话共用同一配置根（~/.lingji/pi-agent）。 */
export function piAgentsTargetDir(): string {
  return path.join(os.homedir(), '.lingji', 'pi-agent', 'agents');
}

function parseRoleMd(raw: string): PiAgentRole {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const tools = (meta.tools ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: meta.name ?? '',
    version: meta.version ?? '0',
    tools,
    systemPrompt: body.trim(),
  };
}

async function readRoleFile(filePath: string): Promise<PiAgentRole | null> {
  try {
    return parseRoleMd(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 按 version 强制同步：种子版本与目标不一致（或目标缺失）即覆盖。 */
export async function ensurePiAgentRoles(seedRoot: string, targetRoot = piAgentsTargetDir()): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  for (const name of PI_AGENT_ROLE_NAMES) {
    const seedPath = path.join(seedRoot, `${name}.md`);
    const targetPath = path.join(targetRoot, `${name}.md`);
    const seed = await readRoleFile(seedPath);
    if (!seed) continue; // 种子缺失时保留目标现状
    const target = await readRoleFile(targetPath);
    if (!target || target.version !== seed.version) {
      await fs.copyFile(seedPath, targetPath);
    }
  }
}

/** 读取角色定义：优先用户目录（可微调），缺失回退种子。 */
export async function loadPiAgentRole(
  name: PiAgentRoleName,
  opts: { seedRoot: string; targetRoot?: string },
): Promise<PiAgentRole> {
  const targetRoot = opts.targetRoot ?? piAgentsTargetDir();
  const role =
    (await readRoleFile(path.join(targetRoot, `${name}.md`))) ??
    (await readRoleFile(path.join(opts.seedRoot, `${name}.md`)));
  if (!role || !role.systemPrompt) {
    throw new Error(`pi 角色定义缺失或为空: ${name}`);
  }
  return role;
}
