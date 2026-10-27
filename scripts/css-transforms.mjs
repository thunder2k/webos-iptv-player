// Build-time CSS transforms consumed by esbuild.config.mjs.
//
// - Flex gap: generate sibling margins for webOS versions without flex gap.
// - Scroll end padding: give horizontal flex scrollers a real end spacer for
//   engines that leave the end padding out of the scroll width.
// - Font scale: wrap pixel font sizes in the app-wide --font-scale variable.
// - Legacy colors: convert modern rgb(var(...) / alpha) syntax for Chrome 53.
// - CSS variables: resolve var(--name) to actual values for Chromium 38.
import postcss from 'postcss';

const RGB_PROP_RE = /^--[\w-]+-rgb$/;
const RGB_VAR_ALIAS_RE = /^var\((--[\w-]+)\)$/;
const MODERN_RGB_USAGE_RE = /rgb\(\s*var\((--[\w-]+)\)\s*\/\s*([^()]+)\)/g;

const GRID_DISPLAY_RE = /\bgrid\b/;

export const SCROLL_END_QUIRK = 'html.q-scroll-end-padding';
export const NO_FLEX_GAP_QUIRK = 'html.q-no-flex-gap';

function selectorParts(selector) {
  return selector.split(',').map((part) => part.trim());
}

function lastCompound(part) {
  return part.split(/[\s>+~]+/).filter(Boolean).pop() || part;
}

function isSingleRowGrid(templateColumns) {
  return postcss.list.space(templateColumns).length > 1;
}

function collectGridOverrides(stylesheets) {
  const claimed = new Set();
  for (const css of stylesheets) {
    postcss.parse(css).walkAtRules('supports', (atRule) => {
      if (!GRID_DISPLAY_RE.test(atRule.params)) return;
      atRule.walkRules((rule) => {
        let spaces = false;
        rule.walkDecls((decl) => {
          if (/^margin(-|$)/.test(decl.prop) && !/\bauto\b/.test(decl.value)) spaces = true;
          if (decl.prop === 'flex-wrap' && decl.value.trim() !== 'nowrap') spaces = true;
        });
        if (!spaces) return;
        for (const part of selectorParts(rule.selector)) {
          for (const compound of part.split(/[\s>+~]+/).filter(Boolean)) claimed.add(compound);
        }
      });
    });
  }
  return claimed;
}

function collectFlexContext(stylesheets) {
  const context = new Map();
  const record = (key, prop, value) => {
    const entry = context.get(key) || {};
    entry[prop] = value;
    context.set(key, entry);
  };

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      rule.walkDecls((decl) => {
        if (decl.prop !== 'display' && decl.prop !== 'flex-direction') return;
        for (const part of selectorParts(rule.selector)) record(part, decl.prop, decl.value.trim());
      });
    });
  }

  return context;
}

// Emit in index.html's link order, not whatever readdir returns, so the
// generated cascade resolves an equal-specificity pair the same way the source
// cascade does. A stylesheet that is never linked would silently lose its
// fallback, so demand that the two sets match.
export function linkedStylesheets(indexHtml, cssDirFiles, generated) {
  const linked = [];
  const pattern = /<link[^>]+href="css\/([\w-]+\.css)"/g;
  for (let match = pattern.exec(indexHtml); match; match = pattern.exec(indexHtml)) {
    if (match[1] !== generated) linked.push(match[1]);
  }
  const sources = cssDirFiles.filter((file) => file.endsWith('.css') && file !== generated);
  const unlinked = sources.filter((file) => linked.indexOf(file) === -1);
  if (unlinked.length) throw new Error(`css/ files not linked in index.html: ${unlinked.join(', ')}`);
  return linked;
}

function boxSide(shorthand, index) {
  const values = postcss.list.space(shorthand || '');
  if (!values.length) return '';
  if (index === 2) return values[2] || values[0];
  return values[index] || values[0];
}

function subtract(first, ...rest) {
  const terms = [first, ...rest];
  if (terms.every((term) => /^-?\d*\.?\d+px$/.test(term))) {
    const value = terms.slice(1).reduce((sum, term) => sum - parseFloat(term), parseFloat(first));
    return `${String(Math.round(value * 100) / 100)}px`;
  }
  return `calc(${terms.join(' - ')})`;
}

const SCROLLING_RE = /^(auto|scroll)$/;
const ZERO_LENGTH_RE = /^0(px|r?em|%)?$/;
const SPACER_PROP_RE = /^(display|flex-direction|flex-wrap|justify-content|overflow(-x)?|padding(-right|-inline-end)?|gap|column-gap)$/;

function generateScrollEndSpacers(stylesheets) {
  const declared = new Map();
  const pseudoAfter = new Set();
  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      for (const part of selectorParts(rule.selector)) {
        if (/::?after\b/.test(part)) pseudoAfter.add(part.replace(/::?after\b.*$/, '').trim());
        const entry = declared.get(part) || {};
        rule.walkDecls((decl) => { entry[decl.prop] = decl.value.trim(); });
        declared.set(part, entry);
      }
    });
  }

  const spacerFor = (d) => {
    if (!/^inline-flex$|^flex$/.test(d.display || '')) return null;
    if ((d['flex-direction'] || 'row') !== 'row') return null;
    const overflow = postcss.list.space(d.overflow || '');
    if (!/^(auto|scroll)$/.test(d['overflow-x'] || overflow[0] || '')) return null;
    if (!/^(|nowrap)$/.test(d['flex-wrap'] || '')) return null;
    if (!/^(|normal|start|flex-start)$/.test(d['justify-content'] || '')) return null;
    const padding = d['padding-right'] || d['padding-inline-end'] || boxSide(d.padding, 1);
    if (!padding || /^0(px|r?em|%)?$/.test(padding)) return null;
    const gapValues = postcss.list.space(d.gap || '');
    const rawGap = d['column-gap'] || gapValues[1] || gapValues[0];
    const gap = rawGap && !/^0(px|r?em|%)?$/.test(rawGap) ? rawGap : '';
    return {
      modern: "content: ''; flex: 0 0 1px; width: 1px; height: 1px; "
        + `margin-left: ${gap ? subtract(padding, gap, '1px') : subtract(padding, '1px')}; `
        + `margin-right: ${subtract('0px', padding)};`,
      legacy: gap ? `margin-left: ${subtract(padding, '1px')};` : '',
    };
  };

  const modern = [];
  const legacy = [];
  const emit = (selector, spacer) => {
    if (pseudoAfter.has(selector)) {
      throw new Error(`${selector} scrolls with end padding but already styles ::after; `
        + 'give it a scroll-end spacer by hand');
    }
    modern.push(`${SCROLL_END_QUIRK} ${selector}::after { ${spacer ? spacer.modern : 'content: none;'} }`);
    if (spacer && spacer.legacy) legacy.push(`${NO_FLEX_GAP_QUIRK} ${selector}::after { ${spacer.legacy} }`);
  };
  const classesOf = (compound) => compound.match(/\.[\w-]+/g) || [];
  const scrollers = [];
  for (const [selector, d] of declared) {
    const spacer = spacerFor(d);
    if (!spacer) continue;
    emit(selector, spacer);
    scrollers.push(selector);
  }
  for (const base of scrollers) {
    if (/[\s>+~]/.test(base)) continue;
    const baseClasses = classesOf(base);
    for (const [selector, d] of declared) {
      if (selector === base || selector.indexOf(':') !== -1) continue;
      const own = classesOf(lastCompound(selector));
      if (!baseClasses.every((cls) => own.indexOf(cls) !== -1)) continue;
      if (!Object.keys(d).some((prop) => SPACER_PROP_RE.test(prop))) continue;
      emit(selector, spacerFor(Object.assign({}, declared.get(base), d)));
    }
  }
  return { modern, legacy };
}

export function generateFlexGapFallback(stylesheets) {
  const rules = [];
  const context = collectFlexContext(stylesheets);
  const gridOverrides = collectGridOverrides(stylesheets);

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      let display = '';
      let direction = '';
      let gap = '';
      let rowGap = '';
      let columnGap = '';
      let templateColumns = '';

      rule.walkDecls((decl) => {
        const value = decl.value.trim();
        if (decl.prop === 'display') display = value;
        if (decl.prop === 'flex-direction') direction = value;
        if (decl.prop === 'gap') gap = value;
        if (decl.prop === 'row-gap') rowGap = value;
        if (decl.prop === 'column-gap') columnGap = value;
        if (decl.prop === 'grid-template-columns') templateColumns = value;
      });

      if (!gap && !rowGap && !columnGap) return;

      const parts = selectorParts(rule.selector);
      const inherited = (prop) => {
        for (const part of parts) {
          const value = context.get(part)?.[prop] || context.get(lastCompound(part))?.[prop];
          if (value) return value;
        }
        return '';
      };

      const resolvedDisplay = display || inherited('display');
      const isGrid = GRID_DISPLAY_RE.test(resolvedDisplay);
      if (isGrid && (!isSingleRowGrid(templateColumns)
          || parts.some((part) => gridOverrides.has(lastCompound(part))))) return;

      const resolvedDirection = direction || inherited('flex-direction') || 'row';
      const column = !isGrid && resolvedDirection.startsWith('column');
      const gapValues = postcss.list.space(gap);
      const shorthandRowGap = gapValues[0] || '';
      const shorthandColumnGap = gapValues[1] || shorthandRowGap;
      const spacing = column
        ? rowGap || shorthandRowGap
        : columnGap || shorthandColumnGap;
      if (!spacing) return;
      const margin = column ? 'margin-top' : 'margin-left';
      const reset = !isGrid && direction && !display ? ` ${column ? 'margin-left' : 'margin-top'}: 0;` : '';
      const selector = parts.map((part) => `${NO_FLEX_GAP_QUIRK} ${part} > * + *`).join(', ');
      const declaration = `${selector} { ${margin}: ${spacing};${reset} }`;
      rules.push(isGrid ? `@supports not (display: grid) {\n  ${declaration}\n}` : declaration);
    });
  }

  const spacers = generateScrollEndSpacers(stylesheets);
  rules.push(...spacers.legacy);

  return `/*
 * AUTO-GENERATED by scripts/css-transforms.mjs on every build — do not edit.
 * Checked in so its rules show up in review diffs.
 *
 * Every rule is scoped to an engine quirk src/engine-quirks.ts measures at
 * boot, so none of it reaches an engine without the quirk:
 *
 * - ${SCROLL_END_QUIRK}: scroll-end spacers for horizontal flex
 *   scrollers, whose padding-right Chromium before 91 leaves out of the
 *   scroll width.
 * - ${NO_FLEX_GAP_QUIRK}: margin fallbacks for flex \`gap\`, which
 *   Chromium before 84 (webOS 4/5/6) lacks. A single-row grid's margins
 *   also sit under \`@supports not (display: grid)\`: grid gap needs none.
 *
 * Linked FIRST, before any component CSS: this is the base layer. The quirk
 * class adds (0,1,1) specificity, so a component rule that must beat a
 * generated margin — notably \`margin: auto\` — is restated under the same
 * class in legacy-webos-overrides.css, which is linked last.
 */
${spacers.modern.map((rule) => `${rule}\n`).join('')}${rules.map((rule) => `${rule}\n`).join('')}`;
}

export function scaleFontSizes(css) {
  const root = postcss.parse(css);
  root.walkDecls('font-size', (decl) => {
    if (decl.parent.type === 'rule' && decl.parent.selector.includes('::cue')) return;
    decl.value = decl.value.replace(
      /(-?\d*\.?\d+)px\b/g,
      (px) => `calc(${px} * var(--font-scale))`,
    );
  });
  return root.toString();
}

function legacyValueFor(value) {
  const alias = RGB_VAR_ALIAS_RE.exec(value.trim());
  if (alias) return `var(${alias[1]}-legacy)`;
  return value.trim().split(/\s+/).join(', ');
}

export function convertLegacyColorSyntax(css) {
  const root = postcss.parse(css);

  root.walkDecls(/^--[\w-]+-rgb$/, (decl) => {
    const legacyProp = `${decl.prop}-legacy`;
    const hasCompanion = decl.parent.nodes.some((node) => node.prop === legacyProp);
    if (hasCompanion) return;
    decl.cloneAfter({ prop: legacyProp, value: legacyValueFor(decl.value) });
  });

  root.walkDecls((decl) => {
    if (!decl.value.includes('rgb(var(')) return;
    decl.value = decl.value.replace(
      /rgb\(\s*var\((--[\w-]+)\)\s*\/\s*([^()]+)\)/g,
      (_match, name, alpha) => `rgba(var(${name}-legacy), ${alpha.trim()})`,
    );
  });

  return root.toString();
}

// Resolve CSS custom properties (variables) to their actual values for the default theme (midnight).
// Chromium 38 (webOS 3.9) doesn't support CSS custom properties, so we must resolve them at build time.
export function resolveCSSVariables(css) {
  const midnightTheme = {
    '--bg-primary': '#0a0a0f',
    '--catalog-hero-scrim-rgb': '10 10 15',
    '--bg-secondary': '#12121a',
    '--bg-tertiary': '#1a1a2e',
    '--bg-card': '#16213e',
    '--text-primary': '#e8e8e8',
    '--text-secondary': '#a0a0b0',
    '--text-muted': '#666680',
    '--accent': '#00d4ff',
    '--accent-dim': '#0088aa',
    '--accent-rgb': '0 212 255',
    '--accent-glow': 'rgba(0, 212, 255, 0.3)',
    '--danger': '#ff4757',
    '--danger-rgb': '255 71 87',
    '--success': '#2ed573',
    '--warning': '#ffa502',
    '--warning-rgb': '255 165 2',
    '--border': '#2a2a3e',
    '--scrollbar-thumb': '#3a3a4a',
    '--scrollbar-track': '#0a0a0f',
    '--focus-ring': '#00d4ff',
    '--overlay-bg': 'rgba(10, 10, 15, 0.9)',
    '--overlay-border': '#2a2a3e',
    '--input-bg': '#12121a',
    '--input-border': '#2a2a3e',
    '--input-text': '#e8e8e8',
    '--input-placeholder': '#666680',
    '--button-primary-bg': '#00d4ff',
    '--button-primary-text': '#0a0a0f',
    '--button-secondary-bg': '#1a1a2e',
    '--button-secondary-text': '#e8e8e8',
    '--button-danger-bg': '#ff4757',
    '--button-danger-text': '#ffffff',
    '--toast-bg': '#1a1a2e',
    '--toast-text': '#e8e8e8',
    '--modal-bg': '#12121a',
    '--modal-border': '#2a2a3e',
    '--tooltip-bg': '#1a1a2e',
    '--tooltip-text': '#e8e8e8',
    '--scrollbar-thumb-hover': '#4a4a5a',
    '--font-scale': '1',
    '--accent-rgb-legacy': '0, 212, 255',
    '--danger-rgb-legacy': '255, 71, 87',
    '--warning-rgb-legacy': '255, 165, 2',
    '--channel-health-healthy': '#2ed573',
    '--channel-health-suspect': '#ffa502',
    '--channel-health-unavailable': '#ff4757',
    '--transition': '0.2s ease',
    '--radius': '8px',
  };

  let result = css;
  for (const [variable, value] of Object.entries(midnightTheme)) {
    // Simple regex to match var(--variable-name) without fallback handling
    const escaped = variable.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`var\\(${escaped}\\)`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}