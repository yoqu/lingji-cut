import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AudioAssetMetadataEditor } from '../src/components/assets/AudioAssetMetadataEditor';
import { DEFAULT_ASSET_TREATMENT, EMPTY_ASSET_SEMANTIC, type AssetRecord } from '../src/types/assets';

const asset: AssetRecord = {
  id: 'audio-1', name: '克制 BGM', kind: 'audio', role: 'bgm', sourceType: 'manual-import',
  createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
  files: { original: '/tmp/bgm.wav' },
  metadata: {
    contentHash: 'sha256:test', byteSize: 10, durationMs: 90_000,
    audio: { loopable: true, bpm: 92, key: 'C minor', energy: 2, transientType: null },
  },
  semantic: { ...EMPTY_ASSET_SEMANTIC, tags: ['克制', '现代'] },
  treatment: DEFAULT_ASSET_TREATMENT,
  usage: { projectRefs: [], favorite: false },
};

describe('AudioAssetMetadataEditor', () => {
  it('提供声音检索所需的角色、循环、节奏与语义字段', () => {
    const html = renderToStaticMarkup(
      <AudioAssetMetadataEditor asset={asset} onUpdate={vi.fn()} />,
    );
    expect(html).toContain('音频检索元数据');
    expect(html).toContain('素材角色');
    expect(html).toContain('BPM');
    expect(html).toContain('Key');
    expect(html).toContain('瞬态类型');
    expect(html).toContain('可无缝循环');
    expect(html).toContain('情绪与语义标签');
  });
});
