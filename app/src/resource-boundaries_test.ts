import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
test('resource engine stays independent; compatibility readers cannot bring back private schedulers', () => {
  const engine = source('./resources/engine.ts')
  assert.doesNotMatch(engine, /from ['"](?:vue|pinia|node:)/)
  for (const file of ['./live-refresh.ts', './project-live-state.ts']) assert.match(source(file), /createResource/)
  assert.doesNotMatch(source('./live-refresh.ts'), /let (?:timer|current|pending)\b/)
  assert.doesNotMatch(source('./automation-catalog.ts'), /createLiveRefresh|new Map/)
  assert.doesNotMatch(source('./chat-history-snapshot.ts'), /const pools|function chatHistorySnapshots/)
  assert.doesNotMatch(source('./readonly-history-snapshot.ts'), /const snapshots|function readonlyHistorySnapshots/)
})

test('first-party roots install per-app stores and shared resource consumers use module accessors', () => {
  for (const file of ['./main.ts', './mobile-bootstrap.ts']) assert.match(source(file), /createResourceApp as createApp/)
  for (const [file, owner] of [
    ['KnowledgeView.vue', 'useKnowledgeResourceStore'], ['KnowledgeMaintenance.vue', 'useMaintenanceResourceStore'],
    ['WorkflowManager.vue', 'useWorkflowResourceStore'], ['ProjectUsage.vue', 'useCatalogResourceStore'],
    ['FoldersSidebar.vue', 'useCatalogResourceStore'], ['ProjectGroup.vue', 'useBotResourceStore'],
    ['ChatTab.vue', 'useChatResourceStore'],
  ]) assert.match(source('./components/' + file), new RegExp(owner))
  assert.doesNotMatch(source('./components/KnowledgeView.vue'), /createKnowledgeClient/)
  assert.doesNotMatch(source('./components/ProjectUsage.vue'), /await fetch\(/)
  assert.doesNotMatch(source('./components/FoldersSidebar.vue'), /client\.value\.list\(/)
})

test('EventSource is owned by shared transport, never by a module or component', () => {
  const scan = (directory: URL) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory()) { if (!['node_modules', '.test-artifacts'].includes(item.name)) scan(new URL(item.name + '/', directory)); continue }
      if (!/\.(?:ts|vue)$/.test(item.name) || /_test\.ts$/.test(item.name) || item.name === 'live-client.ts') continue
      assert.doesNotMatch(readFileSync(new URL(item.name, directory), 'utf8'), /new EventSource\(/, item.name)
    }
  }
  scan(new URL('./stores/', import.meta.url)); scan(new URL('./components/', import.meta.url))
})
