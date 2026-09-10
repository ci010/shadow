import { defineConfig, presetUno, presetIcons, presetTypography } from 'unocss'

export default defineConfig({
  presets: [
    presetUno({ dark: 'class' }),
    presetIcons(),
    presetTypography({
      cssExtend: {
        'code::before': { content: 'none' },
        'code::after': { content: 'none' },
        'color': 'var(--c-text)',
        'a': { color: 'var(--c-primary)' },
        'strong': { color: 'var(--c-text)' },
        'h1,h2,h3,h4,h5,h6': { color: 'var(--c-text)' },
        'blockquote': { color: 'var(--c-text-body)', 'border-left-color': 'var(--c-border)' },
        'hr': { 'border-color': 'var(--c-border)' },
        'code': { color: 'var(--c-text)' },
        'thead': { 'border-bottom-color': 'var(--c-border)' },
        'thead th': { color: 'var(--c-text)' },
        'tbody tr': { 'border-bottom-color': 'var(--c-border)' },
      },
    }),
  ],
  theme: {
    colors: {
      ink: 'rgb(var(--c-ink) / %alpha)',
      haze: '#f8f9fa',
      flare: '#e09f3e',
      ember: '#e05252',
      moss: '#2ecc71',
      sky: '#5b9bd5',
    },
  },
  shortcuts: {
    // Semantic shortcuts that respond to dark mode via CSS vars
    'bg-surface': 'bg-[var(--c-bg-card)]',
    'bg-surface-soft': 'bg-[var(--c-bg-soft)]',
    'border-default': 'border-[var(--c-border)]',
  },
})
