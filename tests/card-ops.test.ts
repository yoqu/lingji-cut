import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listCards, getCard, getCardContext, updateCard, deleteCard } from '../electron/pipeline/card-ops';

function project(cards: unknown[], segments: unknown[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-card-'));
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    version: 1, createdAt: 'x', updatedAt: 'x', timeline: null,
    stylePresetId: 'nyt-data',
    aiAnalysis: { analysisResult: { segments, cards, coverPrompts: [], summary: '', keywords: [] }, coverCandidates: [] },
    script: { templateId: 'x', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
  }));
  return dir;
}
const CARD = { id: 'c1', segmentId: 's1', type: 'summary', title: '标题', content: '内容', startMs: 0, endMs: 1000, displayDurationMs: 1000, displayMode: 'pip', template: 'default', enabled: true, style: {} };

describe('card-ops', () => {
  it('listCards returns summaries', async () => {
    const dir = project([CARD]);
    try {
      const list = await listCards(dir);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'c1', type: 'summary', title: '标题', enabled: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('getCard returns full card; throws card_not_found', async () => {
    const dir = project([CARD]);
    try {
      expect((await getCard(dir, 'c1')).content).toBe('内容');
      await expect(getCard(dir, 'nope')).rejects.toMatchObject({ code: 'card_not_found' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('updateCard whitelists fields and persists', async () => {
    const dir = project([CARD]);
    try {
      const updated = await updateCard(dir, 'c1', { title: '新标题', enabled: false, type: 'data' } as never);
      expect(updated.title).toBe('新标题');
      expect(updated.enabled).toBe(false);
      expect((updated as any).type).toBe('summary'); // type not whitelisted → unchanged
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards[0].title).toBe('新标题');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('deleteCard removes the card', async () => {
    const dir = project([CARD]);
    try {
      await deleteCard(dir, 'c1');
      const saved = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('getCardContext returns motionSpec and all resolved content type rules', async () => {
    const segment = { id: 's1', title: '数据段', summary: '摘要', startMs: 0, endMs: 1000, semanticType: 'data' };
    const dir = project([CARD], [segment]);
    const userData = mkdtempSync(path.join(os.tmpdir(), 'lingji-settings-'));
    try {
      const context = await getCardContext(dir, userData, { cardId: 'c1' });
      expect(context.style.motionSpec?.banned).toContain('彩虹数据色');
      expect(Object.keys(context.style.contentTypeRules)).toHaveLength(5);
      expect(context.style.contentTypeRules.data).toMatchObject({
        source: 'preset',
        rule: { preferredCarriers: ['trend', 'data-hero', 'comparison'] },
      });
      expect(context.style.contentTypeRules.narration.source).toBe('default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
