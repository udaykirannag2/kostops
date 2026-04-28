import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0f9ff',
          100: '#e0f2fe',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          900: '#0c4a6e',
        },
        atlas: {
          bg:        '#f6f7f9',
          bgSunken:  '#eef0f4',
          card:      '#ffffff',
          ink:       '#0b1220',
          inkSoft:   '#3b475a',
          inkDim:    '#6b7689',
          inkMute:   '#9aa3b2',
          rule:      '#e6e9ef',
          ruleHi:    '#d3d8e0',
          navBg:     '#0e1525',
          navIn:     '#cbd2dd',
          navMute:   '#7d8595',
          ok:        '#1a8754',
          okSoft:    '#e2f3e9',
          warn:      '#c4671b',
          warnSoft:  '#fcefdf',
          red:       '#c63232',
          redSoft:   '#fbe5e5',
          violet:    '#6c4ad9',
          teal:      '#137a7b',
          brandAtlas:'#0b66e4',
          brandSoft: '#e7f0ff',
          brandDeep: '#0a4fb0',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
