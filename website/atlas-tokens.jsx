// Atlas design tokens — extracted from style-3-atlas
// Single source of truth for colors, spacing, type, motion.

const atlas = {
  c: {
    bg: '#f6f7f9',
    bgSunken: '#eef0f4',
    card: '#ffffff',
    ink: '#0b1220',
    inkSoft: '#3b475a',
    inkDim: '#6b7689',
    inkMute: '#9aa3b2',
    rule: '#e6e9ef',
    ruleHi: '#d3d8e0',
    brand: '#0b66e4',
    brandSoft: '#e7f0ff',
    brandDeep: '#0a4fb0',
    navBg: '#0e1525',
    navIn: '#cbd2dd',
    navMute: '#7d8595',
    ok: '#1a8754',
    okSoft: '#e2f3e9',
    warn: '#c4671b',
    warnSoft: '#fcefdf',
    red: '#c63232',
    redSoft: '#fbe5e5',
    violet: '#6c4ad9',
    teal: '#137a7b',
    orange: '#e07a3a',
    cyan: '#3093a8',
  },
  // service color map (consistent across screens)
  svc: {
    EC2: '#0b66e4',
    RDS: '#6c4ad9',
    S3: '#137a7b',
    Bedrock: '#e07a3a',
    CloudFront: '#3093a8',
    Lambda: '#1a8754',
    Other: '#9aa3b2',
  },
  r: { sm: 5, md: 6, lg: 8, xl: 10, pill: 999 },
  s: (n) => n * 4, // 4px base
  font: {
    sans: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
  shadow: {
    sm: '0 1px 2px rgba(11, 18, 32, 0.05)',
    md: '0 2px 8px rgba(11, 18, 32, 0.08)',
    lg: '0 12px 32px rgba(11, 18, 32, 0.16), 0 2px 6px rgba(11, 18, 32, 0.06)',
    drawer: '-12px 0 32px rgba(11, 18, 32, 0.10)',
  },
};

window.atlas = atlas;
