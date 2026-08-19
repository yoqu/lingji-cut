import { describe, expect, it } from 'vitest';
import {
  buildKacutHealthEndpoint,
  formatKacutEndpointForDisplay,
  normalizeKacutMcpEndpoint,
  redactKacutSecrets,
} from '../src/lib/kacut-endpoint';

const ROOT = 'http://127.0.0.1:8765';
const TOKEN = 'test-access-token';
const ENDPOINT = `${ROOT}/mcp?token=${TOKEN}`;
const CONFIG = JSON.stringify({
  mcpServers: {
    'lingji-material': { url: ENDPOINT },
  },
});

describe('灵机素材 MCP 地址', () => {
  it('兼容旧根地址与完整 MCP endpoint', () => {
    expect(normalizeKacutMcpEndpoint(ROOT)).toBe(`${ROOT}/mcp`);
    expect(normalizeKacutMcpEndpoint(ENDPOINT)).toBe(ENDPOINT);
    expect(normalizeKacutMcpEndpoint(`${ROOT}/mcp/health?token=${TOKEN}`)).toBe(ENDPOINT);
  });

  it('从标准 mcpServers JSON 提取 lingji-material URL', () => {
    expect(normalizeKacutMcpEndpoint(CONFIG)).toBe(ENDPOINT);
    expect(buildKacutHealthEndpoint(CONFIG)).toBe(`${ROOT}/mcp/health?token=${TOKEN}`);
  });

  it('拒绝无效配置，并在展示或错误中遮盖 token', () => {
    expect(normalizeKacutMcpEndpoint('{"mcpServers":{}}')).toBeNull();
    expect(normalizeKacutMcpEndpoint('file:///tmp/mcp')).toBeNull();
    expect(formatKacutEndpointForDisplay(ENDPOINT)).toContain('token=********');
    expect(formatKacutEndpointForDisplay(ENDPOINT)).not.toContain(TOKEN);
    expect(redactKacutSecrets(`request failed: ${ENDPOINT}`)).not.toContain(TOKEN);
  });
});
