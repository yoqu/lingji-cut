// cli/src/args.ts
export interface ParsedArgs {
  group?: string;
  action?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** 已知布尔开关（不吞掉后一个 token 作为值） */
const BOOLEAN_FLAGS = new Set(['wait', 'json', 'export', 'editor', 'context', 'files', 'settings', 'headful', 'force', 'help']);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  const [group, action, ...positionals] = rest;
  return { group, action, positionals, flags };
}
