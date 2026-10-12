import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileStyle } from 'vue/compiler-sfc'

test('focusable containers do not become clickable merely from tabindex', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  const compiled = compileStyle({ source, filename: 'styles.css', id: 'cursor', scoped: false })
  assert.deepEqual(compiled.errors, [])
  let clickable = false
  compiled.rawResult!.root.walkRules(rule => {
    if (!rule.nodes.some(node => node.type === 'decl' && node.prop === 'cursor' && node.value === 'pointer')) return
    assert.ok(rule.selectors.every(selector => !selector.includes('[tabindex]')), 'tabindex is a focus mechanism, not a click affordance')
    if (rule.selectors.includes('[role="button"]')) clickable = true
  })
  assert.equal(clickable, true, 'actual button roles retain a pointer')
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(chat, /class="chat-messages" tabindex="-1"/, 'programmatic focus remains available')
})
