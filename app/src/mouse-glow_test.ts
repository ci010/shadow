import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileStyle, parse } from 'vue/compiler-sfc'

test('cursor follower is removed while Reveal remains installed', async () => {
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(app)
  const source = descriptor.styles.map(style => style.content).join('\n')
  const compiled = compileStyle({ source, filename: 'App.vue', id: 'cursor-glow', scoped: true })
  assert.deepEqual(compiled.errors, [])
  assert.doesNotMatch(app, /mouse-glow|glowEl|onMouseMove|requestAnimationFrame\(tick\)|cancelAnimationFrame\(rafId\)/)
  assert.match(app, /stopRevealBorder = installRevealBorder\(\)/)
  assert.match(app, /stopRevealBorder\?\.\(\)/)
})
