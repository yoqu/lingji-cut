import { listStylePresets } from '../lib/card-style-presets';
import { StylePresetPreview } from './StylePresetPreview';
import styles from './StyleLibraryPanel.module.css';

export type StyleFacetHint = 'motion' | 'cover' | 'image';

interface StyleLibraryPanelProps {
  /** 当前选中的风格 id（已解析后的有效值） */
  value: string;
  onChange: (id: string) => void;
  /** 哪些 facet 与当前场景相关，用于提示「该风格未定义此场景，将回退默认」 */
  facetHint?: StyleFacetHint;
}

export function StyleLibraryPanel({ value, onChange, facetHint }: StyleLibraryPanelProps) {
  const presets = listStylePresets();
  return (
    <div className={styles.grid}>
      {presets.map((preset) => {
        const selected = preset.id === value;
        // motion facet 已结构化为 motionTokens；其余 facet 仍看提示词块是否非空。
        const missingFacet =
          facetHint != null &&
          (facetHint === 'motion'
            ? !preset.motionTokens
            : !(preset.facets[facetHint] && preset.facets[facetHint]!.trim()));
        return (
          <button
            key={preset.id}
            type="button"
            className={`${styles.card} ${selected ? styles.selected : ''}`}
            onClick={() => onChange(preset.id)}
            aria-pressed={selected}
          >
            <div className={styles.previewBox}>
              <StylePresetPreview motionHtml={preset.preview.motionHtml} className={styles.iframe} />
              {preset.preview.coverImageAsset && (
                <img className={styles.coverThumb} src={preset.preview.coverImageAsset} alt="" />
              )}
            </div>
            <div className={styles.meta}>
              <span className={styles.name}>{preset.name}</span>
              <span className={styles.desc}>{preset.description}</span>
              <span className={styles.tags}>{preset.tags.join(' · ')}</span>
              {missingFacet && (
                <span className={styles.facetWarn}>该风格未定义此场景，将回退默认风格</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
