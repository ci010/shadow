import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileTemplate, parse } from 'vue/compiler-sfc'

test('project settings and folder grouping use shared tooltips on their focusable controls', () => {
  for (const [filename, control, label] of [
    ['ProjectGroup.vue', 'RouterLink', "t('{name} settings', { name: project.name })"],
    ['FoldersSidebar.vue', 'button', "t(folderGrouped ? 'Show unified chats' : 'Group chats by folder')"],
  ]) {
    const source = readFileSync(new URL(`./components/${filename}`, import.meta.url), 'utf8')
    const { descriptor } = parse(source)
    const template = descriptor.template!.content
    assert.deepEqual(compileTemplate({ source: template, filename, id: filename }).errors, [])
    const wrapper = template.split(`<HoverInfo :text="${label}">`)[1]?.split('</HoverInfo>')[0]
    assert.ok(wrapper, `${filename}: localized shared tooltip`)
    assert.ok(wrapper.includes('#default="{ triggerProps }"'))
    const trigger = wrapper.match(new RegExp(`<${control}\\b[^>]*>`))?.[0]
    assert.ok(trigger, `${filename}: focusable trigger`)
    assert.ok(trigger.includes('v-bind="triggerProps"'))
    assert.ok(trigger.includes(`:aria-label="${label}"`))
    assert.ok(!trigger.includes(':title='), 'no competing native tooltip')
  }
})
