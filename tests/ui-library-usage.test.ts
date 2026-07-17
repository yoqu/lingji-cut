import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_DIR, '..', relativePath), 'utf8');
}

function listTsxFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(TEST_DIR, '..', relativeDir);
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) return listTsxFiles(relativePath);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [relativePath] : [];
  });
}

describe('AI assistant business components use the shared UI library', () => {
  it('keeps settings business components free of raw form controls', () => {
    const settingsFiles = [
      'src/pages/Settings.tsx',
      ...listTsxFiles('src/components/settings'),
    ];

    for (const file of settingsFiles) {
      expect(readSource(file), file).not.toMatch(/<(?:button|input|select|textarea)\b/);
    }
  });

  it('keeps AI inspectors typography aligned with design.pen', () => {
    const cardInspectorCss = readSource('src/components/AICardInspector.module.css');

    expect(cardInspectorCss).toMatch(/\.textInput\s*{[^}]*font-size:\s*var\(--font-size-md\);/s);
    expect(cardInspectorCss).toMatch(/\.textArea\s*{[^}]*font-size:\s*var\(--font-size-sm\);/s);
    expect(cardInspectorCss).toMatch(/\.promptArea\s*{[^}]*font-size:\s*var\(--font-size-sm\);/s);
    expect(cardInspectorCss).toMatch(/\.dangerTitle\s*{[^}]*font-size:\s*var\(--font-size-md\);/s);
  });

  it('keeps the asset library shell aligned with design.pen', () => {
    const editorCss = readSource('src/pages/Editor.module.css');
    const editorSource = readSource('src/pages/Editor.tsx');
    const assetCardCss = readSource('src/components/AssetCard.module.css');
    const assetPanelCss = readSource('src/components/AssetPanel.module.css');

    expect(editorCss).toMatch(/\.sidebarTabsTrigger\s*{[^}]*min-height:\s*27px;/s);
    expect(editorSource).toContain('<AppIcon name="folder-open" size={14}');
    expect(editorSource).toContain('<AppIcon name="film" size={14}');
    expect(editorSource).toContain('<EditorShotNavigator');
    expect(assetCardCss).toMatch(
      /\.root\s*{[^}]*width:\s*96px;[^}]*height:\s*96px;[^}]*border-radius:\s*var\(--radius-lg\);/s,
    );
    expect(assetPanelCss).toMatch(/\.filterPill\s*{[^}]*min-height:\s*22px\s*!important;/s);
  });

  it('keeps AssetCenter type filters on one line', () => {
    const assetCenterCss = readSource('src/pages/AssetCenter.module.css');

    expect(assetCenterCss).toMatch(
      /\.filterTabs\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(54px,\s*max-content\)\);/s,
    );
    expect(assetCenterCss).toMatch(/\.typeButton\s*{[^}]*white-space:\s*nowrap;/s);
    expect(assetCenterCss).toMatch(/\.typeButton\s*{[^}]*min-width:\s*54px;/s);
  });

  it('keeps SubtitleInspector free of local compact field shells and raw select controls', () => {
    const source = readSource('src/components/SubtitleInspector.tsx');

    expect(source).not.toContain('function CompactColorField');
    expect(source).not.toContain('function CompactNumberField');
    expect(source).not.toContain('function CompactSwitch');
    expect(source).not.toContain('<select');
  });

  it('keeps AICardInspector free of raw button elements', () => {
    const source = readSource('src/components/AICardInspector.tsx');

    expect(source).not.toContain('<button');
  });

  it('keeps AIPanel free of raw button and textarea elements', () => {
    const source = readSource('src/components/AIPanel.tsx');

    expect(source).not.toContain('<button');
    expect(source).not.toContain('<textarea');
  });

  it('keeps AICoverPanel free of raw button and textarea elements', () => {
    const source = readSource('src/components/AICoverPanel.tsx');

    expect(source).not.toContain('<button');
    expect(source).not.toContain('<textarea');
  });

  it('keeps AICardList free of raw checkbox inputs', () => {
    const source = readSource('src/components/AICardList.tsx');

    expect(source).not.toContain('type="checkbox"');
  });

  it('keeps the Editor sidebar panel switch free of raw top-tab buttons', () => {
    const source = readSource('src/pages/Editor.tsx');

    expect(source).not.toContain('<button');
  });

  it('keeps the timeline context menu typography aligned with the compact timeline scale', () => {
    const source = readSource('src/ui/components/context-menu.tsx');

    expect(source).toContain('w-[148px]');
    expect(source).toContain('text-[10px]');
    expect(source).toContain('text-[9px]');
    expect(source).not.toContain('min-w-[176px]');
    expect(source).not.toContain('text-[11px]');
  });
});
