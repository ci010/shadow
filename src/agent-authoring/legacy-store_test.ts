import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { conversationBindingKey, type ResourceBundle } from './contracts.ts'
import { AgentResourceStore } from './store.ts'
import { executeAuthoredTool } from './tool-runtime.ts'

const address = { projectId: 'synthetic-project', botInstanceId: 'bot', platform: 'qq', conversationId: 'group' }
const markdown = (frontmatter: unknown) => `---\n${JSON.stringify(frontmatter)}\n---\nSynthetic instructions.`
const legacyTool = (capabilities: unknown = ['issues-api']) => ({
  source: 'issues.js', description: 'Synthetic issue lookup', parameters: { type: 'object' }, capabilities,
})
function legacyBundle(): ResourceBundle {
  return {
    version: 1,
    files: {
      'agents/helper/AGENT.md': markdown({ allowedTools: ['xmcl_issues', 'xmcl_notify'] }),
      'skills/support/SKILL.md': markdown({ tools: {
        xmcl_issues: legacyTool(),
        xmcl_notify: { ...legacyTool(['owner-inbox']), source: 'notify.js' },
      } }),
      'skills/support/issues.js': `async function run(args, capabilities) {
        if (args.deny) {
          try { await capabilities.call(args.deny, {}); } catch { return "denied"; }
        }
        return capabilities.call("issues-api", { method: "GET", path: "/issues" });
      }`,
      'skills/support/notify.js': `async function run(args, capabilities) {
        return capabilities.call("owner-inbox", { content: args.content, idempotencyKey: args.key });
      }`,
    },
    bindings: [{
      botInstanceId: 'bot', platform: 'qq', conversationId: 'group', agent: 'helper',
      enabled: true, skills: ['support'], readFolders: [], parameters: {},
      grants: [
        { id: 'issues-api', kind: 'http', origin: 'https://synthetic.example', routes: [{ method: 'GET', path: '/issues' }] },
        { id: 'owner-inbox', kind: 'inbox', sessionId: 'web:orchestrator' },
        { id: 'unused-grant', kind: 'inbox', sessionId: 'web:orchestrator' },
      ],
    }],
  }
}

async function fixture(t: TestContext, bundle = legacyBundle()) {
  const directory = resolve(`.legacy-resource-test-${randomUUID()}`)
  mkdirSync(directory)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = { directory, projectId: address.projectId }
  const original = new AgentResourceStore(options)
  const snapshot = await original.stage({ expectedRevision: original.draft().revision, bundle })
  const file = join(directory, 'resources.json')
  const document = {
    version: 1, projectId: address.projectId, draft: structuredClone(snapshot), published: structuredClone(snapshot),
    history: [structuredClone(snapshot)], managed: [conversationBindingKey(address)],
  }
  writeFileSync(file, JSON.stringify(document))
  return { options, file, snapshot, document }
}

test('legacy v1 tools reopen with exact grant authority and unchanged revisioned resources', async t => {
  const { options, file, snapshot, document } = await fixture(t)
  const store = new AgentResourceStore(options)
  assert.deepEqual(store.snapshot(), snapshot)
  assert.deepEqual(store.draft(), snapshot)
  assert.deepEqual(store.history(), [{ revision: snapshot.revision }])
  assert.equal(store.isManaged(address), true)
  assert.equal(store.validate().valid, true)
  const policy = store.resolve(address)!
  assert.deepEqual(policy.binding, snapshot.bundle.bindings[0])
  assert.deepEqual(policy.agent.allowedModules, ['@shadow/issues-api', '@shadow/owner-inbox'])
  assert.deepEqual(policy.tools.map(tool => tool.imports), [['@shadow/issues-api'], ['@shadow/owner-inbox']])

  const calls: Array<[string, Record<string, unknown>]> = []
  const execute = (name: string, args: Record<string, unknown>) => {
    const tool = policy.tools.find(tool => tool.name === name)!
    return executeAuthoredTool({
      code: tool.code, args, filename: tool.source, signal: new AbortController().signal,
      imports: tool.imports, allowedModules: policy.agent.allowedModules,
      callModule: async (name, input) => { calls.push([name, input]); return { ok: true } },
    })
  }
  assert.deepEqual(await execute('xmcl_issues', {}), { ok: true })
  assert.deepEqual(await execute('xmcl_notify', { content: 'Synthetic report', key: 'one' }), { ok: true })
  assert.equal(await execute('xmcl_issues', { deny: 'owner-inbox' }), 'denied')
  assert.equal(await execute('xmcl_issues', { deny: 'unused-grant' }), 'denied')
  assert.deepEqual(calls, [
    ['issues-api', { method: 'GET', path: '/issues' }],
    ['owner-inbox', { content: 'Synthetic report', idempotencyKey: 'one' }],
  ])
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(persisted, { ...document, version: 2, legacyRevisions: [snapshot.revision] })
  const beforeRestart = readFileSync(file, 'utf8')
  assert.deepEqual(new AgentResourceStore(options).resolve(address), policy)
  assert.equal(readFileSync(file, 'utf8'), beforeRestart)

  const modern = structuredClone(snapshot.bundle)
  modern.files['agents/helper/AGENT.md'] = markdown({
    allowedTools: ['xmcl_issues', 'xmcl_notify'], allowedModules: policy.agent.allowedModules,
  })
  modern.files['skills/support/SKILL.md'] = markdown({ tools: Object.fromEntries(policy.tools.map(tool => [
    tool.name, { source: tool.source, description: tool.description, parameters: tool.parameters, imports: tool.imports },
  ])) })
  for (const tool of policy.tools) modern.files[`skills/support/${tool.source}`] = tool.code
  const draft = await store.stage({ expectedRevision: snapshot.revision, bundle: modern })
  await store.publish(draft.revision)
  await store.rollback(snapshot.revision, draft.revision)
  assert.deepEqual(store.snapshot(), snapshot)
  assert.deepEqual(store.draft(), draft)
  assert.deepEqual(new AgentResourceStore(options).resolve(address), policy)
})

test('compatibility never authorizes new legacy revisions, including after a restart', async t => {
  const { options, snapshot } = await fixture(t)
  const store = new AgentResourceStore(options)
  const changed = structuredClone(snapshot.bundle)
  changed.files['skills/support/issues.js'] += '\n// a new legacy revision'
  const draft = await store.stage({ expectedRevision: snapshot.revision, bundle: changed })
  assert.equal(store.validate().valid, false)
  await assert.rejects(store.publish(draft.revision), /capabilities/)
  const reopened = new AgentResourceStore(options)
  assert.equal(reopened.validate().valid, false)
  assert.deepEqual(reopened.snapshot(), snapshot)
  await assert.rejects(reopened.publish(draft.revision), /capabilities/)
})

test('legacy tools cannot gain native modules or ambient host APIs', async t => {
  const bundle = legacyBundle()
  bundle.files['skills/support/issues.js'] = `async function run() {
    return [typeof process, typeof require, typeof fetch, typeof Buffer];
  }`
  const { options } = await fixture(t, bundle)
  const policy = new AgentResourceStore(options).resolve(address)!
  const tool = policy.tools[0]
  const execute = (code: string) => executeAuthoredTool({
    code, args: {}, signal: new AbortController().signal,
    imports: tool.imports, allowedModules: policy.agent.allowedModules,
    callModule: async () => { assert.fail('No capability should execute') },
  })
  assert.deepEqual(await execute(tool.code), Array(4).fill('undefined'))
  await assert.rejects(execute(tool.code.replace(
    'return [typeof process, typeof require, typeof fetch, typeof Buffer];',
    'return import("node:fs");',
  )), /import_denied/)
})

test('unsafe or ambiguous legacy declarations fail without rewriting the persisted document', async t => {
  const mutations: Array<(bundle: ResourceBundle) => void> = [
    bundle => { bundle.files['skills/support/SKILL.md'] = markdown({ tools: { xmcl_issues: legacyTool('issues-api') } }) },
    bundle => { bundle.files['skills/support/SKILL.md'] = markdown({ tools: { xmcl_issues: legacyTool(['node:fs']) } }) },
    bundle => { bundle.files['skills/support/SKILL.md'] = markdown({ tools: { xmcl_issues: legacyTool(['issues-api', 'issues-api']) } }) },
    ...[{ imports: ['node:fs'] }, { runtime: 'node-vm' }, { arbitraryPermission: true }, { source: 'issues.ts' }].map(extra =>
      (bundle: ResourceBundle) => {
        bundle.files['skills/support/SKILL.md'] = markdown({ tools: { xmcl_issues: { ...legacyTool(), ...extra } } })
      }),
    bundle => { bundle.bindings[0].grants = [] },
    bundle => { bundle.files['skills/support/issues.js'] = 'export function run() { return true; }' },
    bundle => { bundle.files['skills/support/issues.js'] = '})(); const escapedWrapper = true; (() => {' },
    bundle => {
      bundle.files['agents/helper/AGENT.md'] = markdown({
        allowedTools: ['xmcl_issues', 'xmcl_notify'], allowedModules: [],
      })
    },
    bundle => {
      // A modern declaration cannot inherit a legacy role's inferred ceiling.
      bundle.files['skills/support/SKILL.md'] = markdown({ tools: {
        xmcl_issues: legacyTool(),
        xmcl_notify: { source: 'notify.js', description: 'Modern tool', parameters: { type: 'object' }, imports: ['@shadow/issues-api'] },
      } })
    },
  ]
  for (const mutate of mutations) {
    const bundle = legacyBundle()
    mutate(bundle)
    const { options, file } = await fixture(t, bundle)
    const before = readFileSync(file, 'utf8')
    assert.throws(() => new AgentResourceStore(options))
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('legacy migration verifies hashes and compatibility provenance before changing storage', async t => {
  const { options, file, document } = await fixture(t)
  document.published.bundle.files['skills/support/issues.js'] += '\n// tampered'
  writeFileSync(file, JSON.stringify(document))
  const before = readFileSync(file, 'utf8')
  assert.throws(() => new AgentResourceStore(options), /revision does not match/)
  assert.equal(readFileSync(file, 'utf8'), before)
  writeFileSync(file, JSON.stringify({
    ...document, version: 2, legacyRevisions: [`sha256:${'a'.repeat(64)}`],
  }))
  assert.throws(() => new AgentResourceStore(options), /Unknown legacy resource revision/)
})
