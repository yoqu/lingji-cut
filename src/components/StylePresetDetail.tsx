import type { AISegmentSemanticType } from '../types/ai';
import { getStylePresetById, resolveContentTypeRule } from '../lib/card-style';
import styles from './StylePresetDetail.module.css';

const SEMANTIC_TYPES: Array<{ id: AISegmentSemanticType; label: string }> = [
  { id: 'data', label: '数据' },
  { id: 'explanation', label: '解释' },
  { id: 'quote', label: '引用' },
  { id: 'narration', label: '叙述' },
  { id: 'chapter-transition', label: '章节过渡' },
];

const DENSITY_LABEL = {
  light: '轻',
  normal: '常规',
  heavy: '高',
} as const;

interface StylePresetDetailProps {
  presetId: string;
}

export function StylePresetDetail({ presetId }: StylePresetDetailProps) {
  const preset = getStylePresetById(presetId);
  const tokens = preset.motionTokens;
  const palette = {
    bg: preset.palette.bg,
    ink: preset.palette.ink,
    muted: preset.palette.muted,
    accent: preset.palette.accent,
    ...(tokens?.palette.track ? { track: tokens.palette.track } : {}),
  };
  const motionSpec = preset.motionSpec;

  return (
    <section className={styles.root} aria-labelledby="style-preset-detail-title">
      <header className={styles.header}>
        <div>
          <h3 id="style-preset-detail-title" className={styles.title}>{preset.name}</h3>
          <p className={styles.description}>{preset.description}</p>
        </div>
        <div className={styles.tags} aria-label="风格标签">
          {preset.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      </header>

      <div className={styles.metaLine}>
        <span>来源</span>
        <code>{preset.source}</code>
      </div>

      <div className={styles.columns}>
        <section className={styles.section}>
          <h4>色板</h4>
          <div className={styles.swatches}>
            {Object.entries(palette).map(([name, color]) => (
              <div key={name} className={styles.swatchRow}>
                <span className={styles.swatch} style={{ background: color }} aria-hidden />
                <span>{name}</span>
                <code>{color}</code>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h4>字体</h4>
          <dl className={styles.definitionList}>
            <div><dt>Display</dt><dd>{preset.fonts.display}</dd></div>
            <div><dt>Body</dt><dd>{preset.fonts.body}</dd></div>
            <div><dt>Mono</dt><dd>{preset.fonts.mono}</dd></div>
          </dl>
        </section>
      </div>

      <section className={styles.section}>
        <h4>Motion tokens</h4>
        <dl className={styles.tokenGrid}>
          <div><dt>Type scale</dt><dd>{tokens?.typeScale ? JSON.stringify(tokens.typeScale) : '回退默认'}</dd></div>
          <div><dt>Surface</dt><dd>{tokens?.surface ? JSON.stringify(tokens.surface) : '回退默认'}</dd></div>
          <div><dt>Ambient</dt><dd>{tokens?.ambient ? JSON.stringify(tokens.ambient) : '回退默认'}</dd></div>
          <div><dt>Camera</dt><dd>{tokens?.camera ? JSON.stringify(tokens.camera) : '回退默认'}</dd></div>
          <div><dt>Persona</dt><dd>{tokens?.persona ? JSON.stringify(tokens.persona) : '回退默认'}</dd></div>
        </dl>
      </section>

      <section className={styles.section}>
        <h4>运动细则</h4>
        <dl className={styles.ruleList}>
          <div><dt>图表</dt><dd>{motionSpec?.chartRules ?? '沿用通用工艺'}</dd></div>
          <div><dt>强调</dt><dd>{motionSpec?.emphasisRules ?? '沿用通用工艺'}</dd></div>
          <div><dt>排版</dt><dd>{motionSpec?.typographyRules ?? '沿用通用工艺'}</dd></div>
          <div><dt>禁用</dt><dd>{motionSpec?.banned ?? '无额外禁用项'}</dd></div>
          {preset.motionStyleNotes ? <div><dt>补充</dt><dd>{preset.motionStyleNotes}</dd></div> : null}
        </dl>
      </section>

      <section className={styles.section}>
        <h4>内容类型规则</h4>
        <div className={styles.contentRules}>
          {SEMANTIC_TYPES.map(({ id, label }) => {
            const { rule, source } = resolveContentTypeRule(preset.id, id);
            return (
              <div key={id} className={styles.contentRule}>
                <div className={styles.contentRuleHead}>
                  <strong>{label}</strong>
                  <span className={source === 'preset' ? styles.presetBadge : styles.defaultBadge}>
                    {source === 'preset' ? '预设覆盖' : '共享默认'}
                  </span>
                  {rule.density ? <span className={styles.density}>密度 {DENSITY_LABEL[rule.density]}</span> : null}
                </div>
                <div className={styles.carriers}>{rule.preferredCarriers.join(' → ')}</div>
                <p>{rule.renderingRules}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <h4>Facet 状态</h4>
        <div className={styles.facetRow}>
          <span>Cover <strong>{preset.facets.cover?.trim() ? '已定义' : '回退默认'}</strong></span>
          <span>Image <strong>{preset.facets.image?.trim() ? '已定义' : '回退默认'}</strong></span>
        </div>
      </section>
    </section>
  );
}
