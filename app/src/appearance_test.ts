import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { createGenerator } from 'unocss'
import { parse, compileStyle } from 'vue/compiler-sfc'
import config from '../unocss.config.ts'

const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')

test('scrollbar thumbs contrast against light and dark application surfaces', () => {
  function luminance(hex: string): number {
    const rgb = hex.match(/[0-9a-f]{2}/gi)!.map(component => {
      const channel = parseInt(component, 16) / 255
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
    })
    return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!
  }
  for (const selector of [':root', '.dark']) {
    const block = styles.slice(styles.indexOf(`${selector} {`)).split('}')[0]!
    const color = (token: string) => {
      const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6});`, 'i'))
      assert.ok(match, `${selector} defines ${token}`)
      return luminance(match[1]!)
    }
    for (const thumb of ['--c-scrollbar-thumb', '--c-scrollbar-thumb-hover']) {
      for (const surface of ['--c-bg', '--c-bg-card', '--c-bg-muted', '--c-bg-soft']) {
        const foreground = color(thumb), background = color(surface)
        const contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
        assert.ok(contrast >= 3, `${selector} ${thumb} on ${surface}: ${contrast.toFixed(2)}:1`)
      }
    }
  }
  assert.match(styles, /scrollbar-color: var\(--c-scrollbar-thumb\) transparent;/)
  assert.match(styles, /::-webkit-scrollbar-thumb\s*\{[^}]*background: var\(--c-scrollbar-thumb\);/)
})

test('file source content remains intrinsic-height with composer-sized trailing scroll space', async () => {
  const preview = await readFile(new URL('./components/files/FilePreviewModal.vue', import.meta.url), 'utf8')
  assert.match(preview, /\.inline \.file-modal-text-wrap\s*\{\s*align-self: flex-start;/)
  assert.match(preview, /padding: 20px 24px calc\(var\(--composer-height, 0px\) \+ 48px\);/)
  assert.match(preview, /scroll-padding-bottom: calc\(var\(--composer-height, 0px\) \+ 48px\);/)
})

test('all shape tokens and existing Uno corner utilities resolve to square corners', async () => {
  const names = ['sm', 'control', 'surface', 'overlay', 'pill', 'circle']
  for (const name of names) assert.match(styles, new RegExp(`--radius-${name}:\\s*0px;`))
  const uno = await createGenerator(config)
  const { css } = await uno.generate('rounded rounded-sm rounded-md rounded-lg rounded-full')
  const radii = [...css.matchAll(/border-radius:([^;}]+)/g)].map(match => match[1])
  assert.equal(radii.length, 5)
  for (const radius of radii) assert.match(radius, /^var\(--radius-(?:sm|control|surface|overlay|pill)\)$/)
  assert.match(styles, /\.prose pre,\s*\.prose kbd\s*\{\s*border-radius: var\(--radius-sm\);/)
  assert.doesNotMatch(styles, /!important/)
})

test('app-owned Vue and CSS keep square corners except the cursor highlight, send button and loading indicator', async () => {
  async function check(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      if (entry.isDirectory()) { await check(url); continue }
      if (!/\.(vue|css)$/.test(entry.name)) continue
      const original = await readFile(url, 'utf8')
      const source = url.pathname.endsWith('/App.vue')
        ? original.replace(/(\.mouse-glow\s*\{[^}]*?)border-radius: 50%;/, '$1')
        : url.pathname.endsWith('/components/ChatTab.vue')
          ? original.replace(/(\.composer-send\s*\{[^}]*?)border-radius: 50%;/, '$1')
          : url.pathname.endsWith('/components/SessionActivity.vue')
            ? original.replace(/(\.activity-spinner\s*\{[^}]*?)border-radius: 50%;/, '$1')
              .replace(/(\.working:not\(\.waiting\):not\(\.waiting-for-call\) \.activity-symbol::after\s*\{[^}]*?)border-radius: 50%;/, '$1')
          : original
      for (const match of source.matchAll(/\bborder(?:-[\w]+)*-radius\s*:\s*([^;}]+)/g)) {
        assert.match(match[1].trim(), /^(?:0(?:px)?|var\(--radius-[\w-]+\))$/, `${url.pathname}: ${match[0]}`)
      }
    }
  }
  await check(new URL('./', import.meta.url))
})

test('cursor highlight remains circular independently of square interface tokens', async () => {
  assert.match(chat, /\.composer-send\s*\{[^}]*width: 32px; height: 32px;[^}]*border-radius: 50%;/)
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(app)
  const sheet = descriptor.styles.map(style => style.content).join('\n')
  assert.match(sheet, /\.mouse-glow\s*\{[^}]*border-radius: 50%;/)
  const compiled = compileStyle({ source: sheet, filename: 'App.vue', id: 'data-v-app', scoped: true })
  assert.deepEqual(compiled.errors, [])
  assert.match(compiled.code, /\.mouse-glow\[data-v-app\]\s*\{[^}]*border-radius: 50%;/)
})

test('loading ring and center stay circular independently of square interface tokens', async () => {
  const source = await readFile(new URL('./components/SessionActivity.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const sheet = descriptor.styles.map(style => style.content).join('\n')
  assert.match(sheet, /\.activity-spinner\s*\{[^}]*width: 14px; height: 14px;[^}]*border-radius: 50%;[^}]*animation: activity-spin \.8s linear infinite;/)
  assert.match(sheet, /\.activity-symbol::after\s*\{[^}]*border-radius: 50%;/)
  assert.match(sheet, /\.activity-dot\s*\{[^}]*border-radius: var\(--radius-circle\);/)
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\) \{ \.activity-spinner \{ animation: none; \} \}/)
  const compiled = compileStyle({ source: sheet, filename: 'SessionActivity.vue', id: 'data-v-activity', scoped: true })
  assert.deepEqual(compiled.errors, [])
  assert.match(compiled.code, /\.activity-spinner\[data-v-activity\]\s*\{[^}]*border-radius: 50%;/)
})

test('assistant, system, compaction, tool and execution rows share one pane-relative width cap without changing user alignment', () => {
  assert.match(styles, /--conversation-item-max-width:\s*80%;/)
  const { descriptor } = parse(chat)
  const sheet = descriptor.styles.map(style => style.content).join('\n')
  assert.match(sheet, /\.chat-messages > :deep\(:is\(\.chat-assistant, \.system-event, \.compaction-summary, \.tool-activity, \.execution-card\)\)\s*\{\s*min-width: 0;\s*max-width: var\(--conversation-item-max-width\);\s*align-self: flex-start;/)
  assert.equal([...sheet.matchAll(/max-width: var\(--conversation-item-max-width\)/g)].length, 1)
  assert.match(sheet, /\.chat-user\s*\{\s*align-self: flex-end;/)
  assert.match(sheet, /\.chat-bubble\s*\{\s*max-width: 80%;/)
  const compiled = compileStyle({ source: sheet, filename: 'ChatTab.vue', id: 'data-v-chat', scoped: true })
  assert.deepEqual(compiled.errors, [])
  assert.ok(/\.chat-messages\[data-v-chat\] >\s+:is\(\.chat-assistant, \.system-event, \.compaction-summary, \.tool-activity, \.execution-card\)/.test(compiled.code))
})
