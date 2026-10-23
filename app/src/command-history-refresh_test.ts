import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const component = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert(script)
const source = ts.createSourceFile('ChatTab.ts', script, ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'refreshDirectHistory')
assert(declaration)
const scheduler = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText

function fixture() {
  let loads = 0
  const state = {
    disposed: false, paneActive: { value: true }, activeSessionId: { value: 'web:fixture' },
    viewingPhysicalId: { value: null as string | null },
    sendRequest: undefined, historyRequest: undefined,
    directRefreshTimer: undefined, directRefreshPending: false,
    deferActiveHistory: false, requestBusy: { value: false },
    setTimeout,
    loadDirectChat(background: boolean) { assert.equal(background, true); loads++ },
  }
  // Execute the actual component scheduler, with only its reactive inputs stubbed.
  const refresh: unknown = runInNewContext(`${scheduler}\nrefreshDirectHistory`, state)
  assert.equal(typeof refresh, 'function')
  assert(typeof refresh === 'function')
  return { state, refresh, loads: () => loads }
}

test('queued command refresh cannot replace a historical segment selected before the timer fires', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.refresh()
  f.state.viewingPhysicalId.value = 'previous-segment'
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 0)
  assert.equal(f.state.directRefreshPending, true)
  f.state.viewingPhysicalId.value = null
  f.refresh()
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 1, 'Returning to current history can consume the pending refresh')
})

test('a queued refresh cannot load a draft after its conversation is cleared', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.refresh()
  f.state.activeSessionId.value = ''
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 0)
})
