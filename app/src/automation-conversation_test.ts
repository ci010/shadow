import assert from 'node:assert/strict'
import test from 'node:test'
import { automationRunPosition, createAutomationConversation } from './automation-conversation.ts'
import { emptyAutomationRunHistory } from './automation-run-history.ts'
import type { AutomationRunSummary } from './automations.ts'

const run = (index: number): AutomationRunSummary => ({
  id: `run-${index}`, sessionId: `cron:run-${index}`,
  startedAt: new Date(Date.UTC(2026, 8, 30, 0, -index)).toISOString(), status: 'completed',
})
const rows = Array.from({ length: 65 }, (_, index) => run(index))
function fixture(initial?: string) {
  const history = emptyAutomationRunHistory()
  let selected = initial
  const opened: Array<{ id: string; replace: boolean }> = []
  let pages = 0
  const navigation = createAutomationConversation(history, {
    selected: () => selected,
    open: (id, replace) => { opened.push({ id, replace }); selected = id },
    loadMore: () => { pages++; history.loading = true },
  })
  function page(count: number) {
    Object.assign(history, { runs: rows.slice(0, count), loaded: true, loading: false, nextOffset: count, total: 65 })
    navigation.reconcile()
  }
  return { history, navigation, opened, page, selected: () => selected, select: (id?: string) => { selected = id; navigation.reconcile() }, pages: () => pages }
}

test('an automation opens its latest independent conversation and follows new runs only in the current view', () => {
  const view = fixture()
  view.navigation.reconcile()
  assert.deepEqual(view.opened, [])
  view.page(30)
  view.navigation.reconcile()
  assert.deepEqual(view.opened, [{ id: 'cron:run-0', replace: true }])
  view.history.runs = [run(-1), ...view.history.runs]
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run--1')
  view.navigation.reconcile()
  view.navigation.previous()
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run-0')
  view.history.runs = [run(-2), ...view.history.runs]
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run-0', 'New dispatches do not replace a historical conversation')
  view.navigation.current()
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run--2')
  assert.equal(view.opened.at(-1)?.replace, false, 'Explicit history navigation is browser-backable')
})

test('previous and next cross page boundaries on demand without skipping or duplicating a run', () => {
  const view = fixture('cron:run-29')
  view.page(30)
  assert.equal(view.pages(), 0)
  assert.equal(automationRunPosition(view.history, view.selected()).hasPrevious, true)
  view.navigation.previous()
  view.navigation.previous()
  assert.equal(view.pages(), 1)
  assert.equal(view.selected(), 'cron:run-29')
  view.page(60)
  assert.equal(view.selected(), 'cron:run-30')
  view.navigation.reconcile()
  view.navigation.next()
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run-29')
  view.select('cron:run-64')
  assert.equal(view.pages(), 2)
  view.page(65)
  assert.equal(automationRunPosition(view.history, view.selected()).hasPrevious, false)
  view.navigation.previous()
  assert.equal(view.pages(), 2)
})

test('deep links locate older runs without replacing them and stop on an explicit loading failure', () => {
  const view = fixture('cron:run-64')
  view.page(30)
  assert.equal(view.pages(), 1)
  assert.deepEqual(view.opened, [])
  view.history.loading = false
  view.history.error = 'Synthetic error'
  view.navigation.reconcile()
  assert.equal(view.pages(), 1)
  view.history.error = ''
  view.navigation.reconcile()
  assert.equal(view.pages(), 2)
  view.page(60)
  assert.equal(view.pages(), 3)
  view.page(65)
  assert.equal(view.selected(), 'cron:run-64')
  assert.deepEqual(view.opened, [])
  view.navigation.current()
  assert.equal(view.selected(), 'cron:run-0')
})

test('explicit selection cancels a pending previous page and missing runs are not silently retargeted', () => {
  const view = fixture('cron:run-29')
  view.page(30)
  view.navigation.previous()
  view.select('cron:run-10')
  view.page(60)
  assert.equal(view.selected(), 'cron:run-10')
  view.select('deleted-run')
  view.page(65)
  assert.equal(view.selected(), 'deleted-run')
  assert.equal(automationRunPosition(view.history, view.selected()).missing, true)
  assert.equal(automationRunPosition(view.history, view.selected()).historical, true)
  assert.deepEqual(view.opened, [])
})

test('a direct latest-run link follows dispatches, and an empty automation creates no conversation', () => {
  const view = fixture('cron:run-0')
  view.page(30)
  view.history.runs = [run(-1), ...view.history.runs]
  view.navigation.reconcile()
  assert.equal(view.selected(), 'cron:run--1')
  const empty = fixture()
  Object.assign(empty.history, { loaded: true })
  empty.navigation.reconcile()
  assert.deepEqual(empty.opened, [])
  assert.equal(empty.pages(), 0)
})

test('reopening an automation waits for refreshed history instead of opening a deleted cached run', () => {
  const view = fixture()
  Object.assign(view.history, { runs: [run(0)], loaded: true, loading: true, total: 1, nextOffset: 1 })
  view.navigation.reconcile()
  assert.deepEqual(view.opened, [])
  Object.assign(view.history, { runs: [], loading: false, total: 0, nextOffset: 0 })
  view.navigation.reconcile()
  assert.deepEqual(view.opened, [])
  assert.equal(view.selected(), undefined)
})
