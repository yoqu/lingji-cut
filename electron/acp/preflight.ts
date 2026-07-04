import type { PreflightCheck } from './types';
import { BinaryManager } from './binary-manager';
import type { AgentConfig } from './config';
import { normalizeAgentId } from './config';
import { getAgentDef } from '../agent-runtime/registry';

/**
 * preflight：唯一注册的 agent（pi）为 in-process SDK，恒可用，无需 CLI 探测。
 *
 * 返回 PreflightCheck[] 契约不变（UI 不崩）：
 *   - Node.js / npx：保留原检查（npm 托管安装/升级仍依赖它们）。
 *   - <agent bin>：inProcess agent 直接 pass。
 *   - API Key：仅对显式配置 custom_api authMode 的 agent 提示（subscription/未配置不阻断）。
 *
 * agentId 可传旧键（claude-acp/pi-acp），内部 normalize 到 claude/codex/pi。
 */
export async function runPreflight(
  binaryManager: BinaryManager,
  config: AgentConfig,
  agentId: string,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const normalizedId = normalizeAgentId(agentId);
  const def = getAgentDef(normalizedId);

  // 1. Node.js
  const nodeVersion = await binaryManager.getNodeVersion();
  if (nodeVersion) {
    checks.push({ label: 'Node.js', status: 'pass', message: nodeVersion });
  } else {
    checks.push({
      label: 'Node.js',
      status: 'fail',
      message: '未安装 Node.js',
      fixAction: 'install',
    });
  }

  // 2. npx
  const npxPath = await binaryManager.findNpxPath();
  if (npxPath) {
    checks.push({ label: 'npx', status: 'pass', message: npxPath });
  } else {
    checks.push({
      label: 'npx',
      status: 'fail',
      message: '未找到 npx',
      fixAction: 'install',
    });
  }

  // 3. Agent：唯一注册的 pi 为 in-process，内置于应用，恒可用。
  if (def) {
    checks.push({ label: def.bin, status: 'pass', message: '内置（无需安装）' });

    // 4. API Key（仅 custom_api 模式提示；subscription/默认不阻断）
    const configData = await config.load();
    const agentEntry = configData.agents[normalizedId];
    if (agentEntry?.authMode === 'custom_api') {
      const apiKey = await config.getApiKey(normalizedId);
      if (apiKey) {
        checks.push({ label: 'API Key', status: 'pass', message: '已配置' });
      } else {
        checks.push({ label: 'API Key', status: 'warn', message: '未设置 API Key' });
      }
    } else {
      checks.push({ label: 'API Key', status: 'pass', message: '使用官方订阅 / CLI 自带凭证' });
    }
  }

  return checks;
}
