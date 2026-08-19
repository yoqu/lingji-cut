import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROLE = readFileSync(new URL('../resources/pi-agents/agents/publish-ingest.md', import.meta.url), 'utf8');
const SKILL = readFileSync(
  new URL('../resources/pi-agents/skills/publish-ingest-workflow/SKILL.md', import.meta.url),
  'utf8',
);
const TOOLS = readFileSync(
  new URL('../resources/pi-agents/skills/publish-ingest-workflow/references/tool-contract.md', import.meta.url),
  'utf8',
);
const CONTRACT = readFileSync(
  new URL('../resources/pi-agents/skills/publish-ingest-workflow/references/draft-contract.md', import.meta.url),
  'utf8',
);

describe('publish-ingest Pi 资源契约', () => {
  it('角色只开放文案工具，禁止 bash/write 与媒体扫描', () => {
    expect(ROLE).toContain('name: publish-ingest');
    expect(ROLE).toContain(
      'tools: [publish_get_context, publish_read_text, publish_generate_metadata, publish_generate_cover_prompt, publish_recommend_partition, publish_validate_draft, publish_submit_draft]',
    );
    expect(ROLE).not.toMatch(/^tools:.*\b(?:bash|shell|curl|write|edit)\b/mu);
    expect(ROLE).not.toContain('publish_list_workdir');
    expect(ROLE).not.toContain('publish_inspect_media');
    expect(ROLE).not.toMatch(/\bpublish_generate_cover\b(?!_prompt)/);
    expect(ROLE).toContain('不得上传');
    expect(ROLE).toContain('不要假设特定文件名');
    expect(ROLE).toContain('skipCoverPrompt');
  });

  it('工作流强调程序选定媒体、模型只作文案', () => {
    expect(SKILL).toContain('由程序扫描');
    expect(SKILL).toContain('不是准入条件');
    expect(SKILL).toContain('已有封面或已有封面提示词时不要调用生成工具');
    expect(TOOLS).toContain('成片和封面不会让你挑选');
    expect(TOOLS).toContain('skipCoverPrompt=false');
    expect(CONTRACT).toContain('不检查文件名模式');
    expect(CONTRACT).toContain('不要提交 `filePath` 或 `covers`');
  });
});
