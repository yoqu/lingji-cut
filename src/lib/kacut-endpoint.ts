export const DEFAULT_KACUT_MCP_ENDPOINT = 'http://127.0.0.1:8765/mcp';

function extractMcpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return trimmed || null;
  try {
    const config = JSON.parse(trimmed) as {
      mcpServers?: Record<string, { url?: unknown }>;
    };
    const servers = config.mcpServers;
    if (!servers || typeof servers !== 'object') return null;
    const named = servers['lingji-material']?.url;
    if (typeof named === 'string' && named.trim()) return named.trim();
    const entries = Object.values(servers).filter(
      (entry): entry is { url: string } => typeof entry?.url === 'string' && Boolean(entry.url.trim()),
    );
    return entries.length === 1 ? entries[0].url.trim() : null;
  } catch {
    return null;
  }
}

/** 接受根地址、完整 MCP URL，或标准 mcpServers JSON，并归一为 POST endpoint。 */
export function normalizeKacutMcpEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const configuredUrl = extractMcpUrl(value);
  if (!configuredUrl) return null;
  try {
    const endpoint = new URL(configuredUrl);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return null;
    endpoint.hash = '';
    const path = endpoint.pathname.replace(/\/+$/, '');
    if (!path || path === '/') endpoint.pathname = '/mcp';
    else if (path.endsWith('/mcp/health')) endpoint.pathname = path.slice(0, -'/health'.length);
    else if (!path.endsWith('/mcp')) endpoint.pathname = `${path}/mcp`;
    else endpoint.pathname = path;
    return endpoint.toString();
  } catch {
    return null;
  }
}

export function buildKacutHealthEndpoint(value: unknown): string | null {
  const normalized = normalizeKacutMcpEndpoint(value);
  if (!normalized) return null;
  const endpoint = new URL(normalized);
  endpoint.pathname = `${endpoint.pathname}/health`;
  return endpoint.toString();
}

export function redactKacutSecrets(value: string): string {
  return value.replace(/([?&]token=)[^&\s"'\\]+/gi, '$1<redacted>');
}

export function formatKacutEndpointForDisplay(value: unknown): string {
  const normalized = normalizeKacutMcpEndpoint(value);
  if (!normalized) return '灵机素材 MCP';
  const endpoint = new URL(normalized);
  if (endpoint.searchParams.has('token')) endpoint.searchParams.set('token', '********');
  return endpoint.toString();
}
