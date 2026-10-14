import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const source = await readFile(new URL('./components/ProjectWorkbench.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const template = descriptor.template!.content
const styles = descriptor.styles.map(style => style.content).join('\n')

test('workbench has one integrated header and no persistent toolbar or tagline', () => {
  const compiled = compileTemplate({ source: template, filename: 'ProjectWorkbench.vue', id: 'header-test' })
  assert.deepEqual(compiled.errors, [])
  const header = template.slice(template.indexOf('<header'), template.indexOf('</header>'))
  for (const control of ['projectName', 'Work view', "t('Dashboard')", "t('Board')", 'organizeTopics', 'diagnosticsOpen', 'filtered.length', 'refresh', 'newWork', 'toggleApps', "panel === 'github'"]) {
    assert.ok(header.includes(control), `Header retains ${control}`)
  }
  assert.ok(!template.includes('workbench-toolbar'))
  assert.ok(!template.includes('Goals, current work and decisions in context'))
  assert.match(header, /v-show="!appsVisible" class="workbench-controls"/)
  assert.match(header, /:disabled="organizing"/)
  assert.match(header, /:disabled="loading"/)
  assert.match(header, /v-if="canWrite"/)
  assert.match(header, /:aria-describedby="modelCallNoticeId"/)
  assert.match(header, /v-if="!appsVisible && view === 'history' && organizationMessage"[^>]+role="status" aria-live="polite"/)
})

test('header groups wrap on small screens without hiding controls or board counts', () => {
  assert.match(styles, /\.workbench-heading \{[^}]*flex-wrap: wrap/)
  assert.match(styles, /\.workbench-controls \{[^}]*flex-wrap: wrap[^}]*min-width: 0/)
  assert.match(styles, /\.workbench-integrations \{[^}]*margin-left: auto/)
  assert.match(styles, /@media \(max-width: 700px\) \{[^]*?\.workbench-controls \{ order: 3; flex-basis: 100%; \}/)
  assert.match(styles, /\.project-identity \{[^}]*text-overflow: ellipsis/)
  assert.ok(!/\.work-count\s*\{[^}]*display:\s*none/.test(styles))
  assert.match(styles, /@media \(pointer: coarse\), \(max-width: 700px\)[^]*min-height: 44px/)
  assert.match(styles, /:focus-visible[^]*outline: 2px solid/)
})
