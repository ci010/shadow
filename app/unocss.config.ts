import { defineConfig, presetWind3, presetIcons, presetTypography } from 'unocss'
import { fileURLToPath } from 'node:url'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export default defineConfig({
  content: {
    // Seed icons before lazy modules load, without creating a second filesystem watcher.
    inline: [() => {
      const root = fileURLToPath(new URL('./src', import.meta.url))
      const icons = new Set<string>()
      for (const path of globSync('**/*.{vue,ts}', { cwd: root, exclude: ['**/*_test.ts'] })) {
        const source = readFileSync(join(root, path), 'utf8')
        for (const match of source.matchAll(/\bi-(?:lucide|simple-icons)-[a-z0-9]+(?:-[a-z0-9]+)*/g)) icons.add(match[0])
      }
      return [...icons].join(' ')
    }],
    pipeline: { include: [/\.(?:vue|[jt]sx?|html)(?:$|\?)/] },
  },
  presets: [
    presetWind3({ dark: 'class' }),
    presetIcons({
      collections: {
        lucide: () => import('@iconify-json/lucide').then(module => module.icons),
        'simple-icons': () => import('@iconify-json/simple-icons').then(module => module.icons),
      },
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
        'flex-shrink': '0',
      },
    }),
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
    borderRadius: {
      DEFAULT: 'var(--radius-control)',
      sm: 'var(--radius-sm)',
      md: 'var(--radius-surface)',
      lg: 'var(--radius-overlay)',
      full: 'var(--radius-pill)',
    },
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
