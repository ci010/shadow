import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentResourceStore } from './store.ts'
import type { ResourceBundle } from './contracts.ts'

const address = { projectId: 'project-one', botInstanceId: 'bot-one', platform: 'qq', conversationId: 'group-one' }
const markdown = (frontmatter: unknown, body: string) => `---\n${JSON.stringify(frontmatter)}\n---\n${body}`
const agent = (overrides: Record<string, unknown> = {}) => markdown({
  name: 'helper', description: 'An authored helper', allowedTools: ['read', 'search', 'lookup'],
  skills: false, allowedModules: ['@shadow/catalog-api'], ...overrides,
}, 'Help this group without private context.')
const skill = (overrides: Record<string, unknown> = {}) => markdown({
  name: 'catalog', description: 'Selected instruction',
  tools: {
    lookup: {
      source: 'lookup.js', description: 'Look up a value',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      imports: ['@shadow/catalog-api'],
    },
  },
  ...overrides,
}, 'Use the selected catalog instruction.')

function bundle(): ResourceBundle {
  return {
    version: 1,
    files: {
      'agents/helper/AGENT.md': agent(),
      'skills/catalog/SKILL.md': skill(),
      'skills/catalog/lookup.js': 'throw new Error("must never execute while authoring"); export async function run() { return "v1"; }',
    },
    bindings: [{
      botInstanceId: 'bot-one', platform: 'qq', conversationId: 'group-one', enabled: true,
      agent: 'helper', skills: ['catalog'], readFolders: ['registered-folder'], parameters: { greeting: 'hello' },
      grants: [{
        id: 'catalog-api', kind: 'http', origin: 'https://catalog.example',
        routes: [{ method: 'POST', path: '/lookup', bodySchema: { type: 'object' } }],
      }],
    }],
  }
}

function fixture(t: TestContext) {
  const directory = resolve(`.agent-authoring-test-${randomUUID()}`)
  mkdirSync(directory)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = { projectId: address.projectId, directory }
  return { directory, options, store: new AgentResourceStore(options) }
}

async function publish(store: AgentResourceStore, content = bundle()) {
  const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: content })
  return store.publish(draft.revision)
}

test('author, preview, publish and resolve pinned custom instructions and code', async t => {
  const { store, directory } = fixture(t)
  const empty = store.snapshot()
  assert.deepEqual(empty.bundle, { version: 1, files: {}, bindings: [] })
  assert.equal(store.validate().valid, true)
  assert.deepEqual(store.history(), [])
  const authored = bundle()
  const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
  assert.equal(store.snapshot().revision, empty.revision)
  assert.equal(store.resolve(address), undefined)
  assert.equal(store.isManaged(address), false)
  assert.equal(store.validate().valid, true)
  const active = await store.publish(draft.revision)
  const policy = store.resolve(address)!
  assert.equal(policy.revision, active.revision)
  assert.equal(policy.agent.name, 'helper')
  assert.equal(policy.agent.source, 'workspace')
  assert.equal(policy.agent.root, false)
  assert.equal(policy.agent.skills, false)
  assert.equal(policy.agent.soul, false)
  assert.equal(policy.agent.dirPath, undefined)
  assert.deepEqual(policy.agent.allowedTools, ['read', 'search', 'lookup'])
  assert.equal(policy.skillPrompts[0].content, 'Use the selected catalog instruction.')
  assert.equal(policy.tools[0].code, authored.files['skills/catalog/lookup.js'])
  assert.equal(policy.binding.parameters.greeting, 'hello')
  assert.equal(store.isManaged(address), true)
  assert(Object.isFrozen(policy.binding.parameters))
  assert(Object.isFrozen(active.bundle.files))
  assert.throws(() => { active.bundle.files['skills/catalog/lookup.js'] = 'mutated' }, TypeError)
  assert.throws(() => readFileSync(join(directory, 'agents', 'helper', 'AGENT.md')), /ENOENT/)
})

test('publishSnapshot captures the exact candidate before awaiting and preserves an unrelated draft', async t => {
  const { store, options } = fixture(t)
  const draftBundle = bundle()
  draftBundle.files['skills/catalog/lookup.js'] = 'export async function run() { return "unfinished"; }'
  const dirty = await store.stage({ expectedRevision: store.draft().revision, bundle: draftBundle })
  const candidate = structuredClone(store.candidate(bundle()))
  const expected = structuredClone(candidate)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let checks = 0
  const publish = store.publishSnapshot(candidate, {
    baseRevision: store.snapshot().revision,
    validateLive: async snapshot => {
      assert.deepEqual(snapshot, expected)
      assert(Object.isFrozen(snapshot.bundle.files))
      entered.resolve()
      await release.promise
    },
    assertPending: () => { checks++ },
  })
  candidate.bundle.files['skills/catalog/lookup.js'] = 'Mutated caller-owned data'
  await entered.promise
  assert.equal(store.snapshot().bundle.bindings.length, 0)
  release.resolve()
  assert.deepEqual(await publish, expected)
  assert.equal(checks, 2)
  assert.deepEqual(store.draft(), dirty)
  const restarted = new AgentResourceStore(options)
  assert.deepEqual(restarted.snapshot(), expected)
  assert.deepEqual(restarted.draft(), dirty)
})

test('publishSnapshot rejects modified source, stale bases, invalid resources and revoked approval', async t => {
  const { store } = fixture(t)
  const base = store.snapshot()
  const candidate = structuredClone(store.candidate(bundle()))
  const approval = { baseRevision: base.revision, validateLive: async () => {} }
  const changed = structuredClone(candidate)
  changed.bundle.files['skills/catalog/lookup.js'] += '\n// changed'
  await assert.rejects(store.publishSnapshot(changed, approval), /revision does not match/)
  const invalid = structuredClone(bundle())
  invalid.files['agents/helper/AGENT.md'] = agent({ allowedTools: ['exec'] })
  await assert.rejects(store.publishSnapshot(store.candidate(invalid), approval), /not permitted/)
  let approved = true
  await assert.rejects(store.publishSnapshot(candidate, {
    ...approval,
    validateLive: async () => { approved = false },
    assertPending: () => { if (!approved) throw new Error('Approval revoked') },
  }), /Approval revoked/)
  assert.deepEqual(store.snapshot(), base)
  await store.publishSnapshot(candidate, approval)
  await assert.rejects(store.publishSnapshot(base, approval), /Stale published revision/)
  assert.deepEqual(store.snapshot(), candidate)
})

test('authored tools cannot shadow management or scheduling tools', t => {
  const { store } = fixture(t)
  for (const name of ['authoring_change', 'cron_add', 'cron_list', 'cron_remove', 'skill_read', 'skill_save', 'cancel', 'continuation']) {
    const resource = bundle()
    resource.files['agents/helper/AGENT.md'] = agent({ allowedTools: [name] })
    resource.files['skills/catalog/SKILL.md'] = skill().replace('"lookup":', `"${name}":`)
    const validation = store.validate(store.candidate(resource))
    assert.equal(validation.valid, false)
    assert.match(validation.errors.join('\n'), new RegExp(`reserved tool alias: ${name}`))
  }
})

test('restart retains draft, immutable history and rollback without discarding edits', async t => {
  const { store, options } = fixture(t)
  const first = await publish(store)
  const edited = bundle()
  edited.files['skills/catalog/lookup.js'] = 'export async function run() { return "v2"; }'
  const second = await publish(store, edited)
  edited.files['skills/catalog/lookup.js'] = 'export async function run() { return "unfinished v3"; }'
  const third = await store.stage({ expectedRevision: store.draft().revision, bundle: edited })
  assert.equal(store.resolve(address)!.tools[0].code, second.bundle.files['skills/catalog/lookup.js'])
  const restarted = new AgentResourceStore(options)
  assert.deepEqual(restarted.snapshot(), second)
  assert.deepEqual(restarted.draft(), third)
  assert.deepEqual(restarted.history(), [{ revision: first.revision }, { revision: second.revision }])
  await assert.rejects(restarted.rollback(first.revision, first.revision), /Stale published/)
  const rolledBack = await restarted.rollback(first.revision, second.revision)
  assert.deepEqual(rolledBack, first)
  assert.deepEqual(restarted.draft(), third)
  assert.deepEqual(new AgentResourceStore(options).snapshot(), first)
  await assert.rejects(restarted.rollback('missing', first.revision), /Unknown or pruned/)
})

test('module tools intersect skill imports, agent ceilings and binding grants with revisioned rollback', async t => {
  const { store, options } = fixture(t)
  const first = await publish(store)
  const moduleBundle = bundle()
  moduleBundle.files['agents/helper/AGENT.md'] = agent({ allowedModules: ['node:path', '@shadow/catalog-api'] })
  moduleBundle.files['skills/catalog/SKILL.md'] = skill({
    tools: { lookup: {
      source: 'lookup.js', description: 'Module lookup',
      imports: ['node:path', '@shadow/catalog-api'], parameters: { type: 'object' },
    } },
  })
  moduleBundle.files['skills/catalog/lookup.js'] = 'import { call } from "@shadow/catalog-api"; export async function run() { return call({method:"POST",path:"/lookup"}); }'
  const current = await publish(store, moduleBundle)
  const restarted = new AgentResourceStore(options)
  assert.deepEqual(restarted.snapshot(), current)
  assert.deepEqual(restarted.resolve(address)!.agent.allowedModules, ['node:path', '@shadow/catalog-api'])
  assert.deepEqual(restarted.resolve(address)!.tools[0].imports, ['node:path', '@shadow/catalog-api'])
  await restarted.rollback(first.revision, current.revision)
  assert.deepEqual(new AgentResourceStore(options).snapshot(), first)
  assert.deepEqual(restarted.resolve(address)!.agent.allowedModules, ['@shadow/catalog-api'])

  for (const [change, error] of [
    [(value: ResourceBundle) => { value.files['agents/helper/AGENT.md'] = agent() }, /Module not allowed/],
    [(value: ResourceBundle) => { value.files['agents/helper/AGENT.md'] = agent({ allowedModules: undefined }) }, /Module not allowed/],
    [(value: ResourceBundle) => { value.files['agents/helper/AGENT.md'] = agent({ allowedModules: [] }) }, /Module not allowed/],
    [(value: ResourceBundle) => { value.bindings[0].grants = [] }, /missing grant/],
    ...['quickjs', 'node-vm'].map(runtime => [
      (value: ResourceBundle) => { value.files['skills/catalog/SKILL.md'] = value.files['skills/catalog/SKILL.md'].replace('"description":"Module lookup"', `"description":"Module lookup","runtime":"${runtime}"`) },
      /Unrecognized key.*runtime/,
    ] as const),
    [(value: ResourceBundle) => { value.files['skills/catalog/SKILL.md'] = value.files['skills/catalog/SKILL.md'].replace('"description":"Module lookup"', '"description":"Module lookup","capabilities":["catalog-api"]') }, /Unrecognized key.*capabilities/],
    [(value: ResourceBundle) => { value.files['skills/catalog/SKILL.md'] = value.files['skills/catalog/SKILL.md'].replace('"node:path"', '"node:path","node:path"') }, /Duplicate script imports/],
    [(value: ResourceBundle) => { value.files['agents/helper/AGENT.md'] = agent({ allowedModules: ['node:module'] }) }, /supported node: module/],
    [(value: ResourceBundle) => { value.files['skills/catalog/SKILL.md'] = value.files['skills/catalog/SKILL.md'].replace('"node:path"', '"file:///private.js"') }, /supported node: module/],
  ] as const) {
    const invalid = structuredClone(moduleBundle)
    change(invalid)
    await restarted.stage({ expectedRevision: restarted.draft().revision, bundle: invalid })
    assert.equal(restarted.validate().valid, false)
    assert.match(restarted.validate().errors.join('\n'), error)
    await assert.rejects(restarted.publish(restarted.draft().revision), error)
    assert.equal(restarted.snapshot().revision, first.revision)
  }
})

test('preview resolves an exact validated draft without publishing or enrolling conversations', async t => {
  const { store, directory } = fixture(t)
  assert.equal(store.preview(address), undefined)
  const published = await publish(store)
  const originalPolicy = store.resolve(address)
  const authored = bundle()
  authored.files['agents/helper/AGENT.md'] = agent().replace('Help this group', 'Preview this group')
  authored.files['skills/catalog/SKILL.md'] = skill().replace('selected catalog instruction', 'draft catalog instruction')
  authored.files['skills/catalog/lookup.js'] = 'throw new Error("preview must not execute"); export async function run() { return "draft"; }'
  const newAddress = { ...address, conversationId: 'draft-only-group' }
  authored.bindings.push({ ...structuredClone(authored.bindings[0]), conversationId: newAddress.conversationId })
  const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
  const history = store.history()
  const persisted = readFileSync(join(directory, 'resources.json'), 'utf8')
  const preview = store.preview(address)!
  assert.equal(preview.revision, draft.revision)
  assert.equal(preview.agent.prompt, 'Preview this group without private context.')
  assert.equal(preview.skillPrompts[0].content, 'Use the draft catalog instruction.')
  assert.equal(preview.tools[0].code, authored.files['skills/catalog/lookup.js'])
  assert.equal(store.preview(newAddress)!.binding.conversationId, newAddress.conversationId)
  assert.deepEqual(store.preview(address, published), originalPolicy)
  assert.equal(store.preview({ ...address, projectId: 'other-project' }), undefined)
  assert.equal(store.preview({ ...address, botInstanceId: 'other-bot' }), undefined)
  assert(Object.isFrozen(preview.tools[0]))
  assert.throws(() => { preview.tools[0].code = 'mutated' }, TypeError)
  assert.deepEqual(store.snapshot(), published)
  assert.deepEqual(store.draft(), draft)
  assert.deepEqual(store.history(), history)
  assert.deepEqual(store.resolve(address), originalPolicy)
  assert.equal(store.resolve(newAddress), undefined)
  assert.equal(store.isManaged(newAddress), false)
  assert.equal(readFileSync(join(directory, 'resources.json'), 'utf8'), persisted)

  const tampered = structuredClone(draft)
  tampered.bundle.files['skills/catalog/lookup.js'] = 'different code'
  assert.throws(() => store.preview(address, tampered), /revision does not match/)
  authored.bindings[0].enabled = false
  await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
  assert.equal(store.preview(address), undefined)
  authored.files['agents/unbound/AGENT.md'] = 'Invalid unrelated agent'
  const invalid = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
  assert.throws(() => store.preview(newAddress), /frontmatter/)
  assert.throws(() => store.preview({ ...address, conversationId: 'missing' }, invalid), /frontmatter/)
  assert.deepEqual(store.snapshot(), published)
  assert.deepEqual(store.history(), history)
  assert.equal(store.isManaged(newAddress), false)
})

test('TypeScript sources persist as snapshots without executing source during validation', async t => {
  const { store, options } = fixture(t)
  const authored = bundle()
  authored.files['skills/catalog/SKILL.md'] = skill().replace('lookup.js', 'lookup.ts')
  delete authored.files['skills/catalog/lookup.js']
  authored.files['skills/catalog/lookup.ts'] = 'throw new Error("metadata must not execute"); export async function run(args: { query: string }) { return args.query; }'
  const published = await publish(store, authored)
  const policy = new AgentResourceStore(options).resolve(address)!
  assert.equal(policy.revision, published.revision)
  assert.equal(policy.tools[0].source, 'lookup.ts')
  assert.equal(policy.tools[0].code, authored.files['skills/catalog/lookup.ts'])
})

test('serialized CAS rejects stale drafts and captures inputs before queueing', async t => {
  const { store } = fixture(t)
  const expectedRevision = store.draft().revision
  const original = bundle()
  original.bindings[0].parameters.nested = { value: 'captured' }
  const changed = bundle()
  changed.bindings[0].parameters.greeting = 'second'
  const first = store.stage({ expectedRevision, bundle: original })
  original.files['skills/catalog/lookup.js'] = 'caller mutation'
  ;(original.bindings[0].parameters.nested as { value: string }).value = 'caller mutation'
  const second = store.stage({ expectedRevision, bundle: changed })
  const results = await Promise.allSettled([first, second])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.notEqual(store.draft().bundle.files['skills/catalog/lookup.js'], 'caller mutation')
  assert.deepEqual(store.draft().bundle.bindings[0].parameters.nested, { value: 'captured' })
  await assert.rejects(store.publish(expectedRevision), /Stale draft/)
  await publish(store, changed)
  assert.equal(store.resolve(address)!.binding.parameters.greeting, 'second')
})

test('revisions canonicalize complete bundles and identical publishes retain unique history', async t => {
  const { store } = fixture(t)
  const first = await publish(store)
  const reordered = bundle()
  reordered.files = Object.fromEntries(Object.entries(reordered.files).reverse())
  reordered.bindings[0].parameters = { greeting: 'hello' }
  const same = await publish(store, reordered)
  assert.equal(first.revision, same.revision)
  assert.deepEqual(store.history(), [{ revision: same.revision }])
  reordered.bindings[0].parameters = { greeting: 'changed' }
  assert.notEqual((await publish(store, reordered)).revision, first.revision)
})

test('invalid drafts preview errors but never replace live publication', async t => {
  const { store, options } = fixture(t)
  const active = await publish(store)
  const mutations: Array<[string, (value: ResourceBundle) => void]> = [
    ['missing agent', b => { b.bindings[0].agent = 'absent' }],
    ['builtin agent', b => { b.bindings[0].agent = 'general' }],
    ['missing skill', b => { b.bindings[0].skills = ['absent'] }],
    ['missing source', b => { delete b.files['skills/catalog/lookup.js'] }],
    ['undeclared source', b => { b.files['skills/catalog/extra.js'] = 'export default 1' }],
    ['missing grant', b => { b.bindings[0].grants = [] }],
    ['duplicate grant', b => { b.bindings[0].grants.push(b.bindings[0].grants[0]) }],
    ['duplicate read folder', b => { b.bindings[0].readFolders.push('registered-folder') }],
    ['duplicate skill', b => { b.bindings[0].skills.push('catalog') }],
    ['duplicate binding', b => { b.bindings.push(structuredClone(b.bindings[0])) }],
    ['unselected tool', b => { b.bindings[0].skills = [] }],
    ['unsafe route', b => { b.bindings[0].grants = [{ id: 'catalog-api', kind: 'http', origin: 'https://catalog.example', routes: [{ method: 'GET', path: '/a/../secret' }] }] }],
    ['encoded route', b => { b.bindings[0].grants = [{ id: 'catalog-api', kind: 'http', origin: 'https://catalog.example', routes: [{ method: 'GET', path: '/%2e%2e/secret' }] }] }],
    ['invalid body schema', b => { b.bindings[0].grants = [{ id: 'catalog-api', kind: 'http', origin: 'https://catalog.example', routes: [{ method: 'POST', path: '/lookup', bodySchema: { type: 'not-a-type' } }] }] }],
    ['self inbox', b => { b.bindings[0].grants.push({ id: 'reply', kind: 'inbox', sessionId: 'bot:project-one:bot-one:qq:group-one' }) }],
    ['legacy self inbox', b => { b.bindings[0].grants.push({ id: 'reply', kind: 'inbox', sessionId: 'qq:group-one' }) }],
    ['missing frontmatter', b => { b.files['agents/helper/AGENT.md'] = 'No frontmatter' }],
    ['malformed frontmatter', b => { b.files['agents/helper/AGENT.md'] = '---\nname: [\n---\nbody' }],
    ['root escalation', b => { b.files['agents/helper/AGENT.md'] = agent({ root: true }) }],
    ['allowlist type', b => { b.files['agents/helper/AGENT.md'] = agent({ allowedTools: 'read,search' }) }],
    ['allowlist item type', b => { b.files['agents/helper/AGENT.md'] = agent({ allowedTools: [1] }) }],
    ['missing allowlist', b => { b.files['agents/helper/AGENT.md'] = markdown({ name: 'helper' }, 'Body') }],
    ['coerced permission', b => { b.files['agents/helper/AGENT.md'] = agent({ skills: 'false' }) }],
    ['unknown frontmatter', b => { b.files['agents/helper/AGENT.md'] = agent({ grants: ['all'] }) }],
    ['name mismatch', b => { b.files['agents/helper/AGENT.md'] = agent({ name: 'different' }) }],
    ['invalid schema', b => { b.files['skills/catalog/SKILL.md'] = skill({ tools: { lookup: { source: 'lookup.js', description: 'Lookup', parameters: { type: 'invalid' }, imports: [] } } }) }],
    ['missing ref', b => { b.files['skills/catalog/SKILL.md'] = skill({ tools: { lookup: { source: 'lookup.js', description: 'Lookup', parameters: { $ref: 'https://example.invalid/schema' }, imports: [] } } }) }],
    ['duplicate import', b => { b.files['skills/catalog/SKILL.md'] = skill({ tools: { lookup: { source: 'lookup.js', description: 'Lookup', parameters: {}, imports: ['@shadow/catalog-api', '@shadow/catalog-api'] } } }) }],
    ['reserved tool', b => { b.files['skills/catalog/SKILL.md'] = skill({ tools: { exec: { source: 'lookup.js', description: 'Lookup', parameters: {}, imports: [] } } }) }],
    ['unsafe tool source', b => { b.files['skills/catalog/SKILL.md'] = skill({ tools: { lookup: { source: '../lookup.js', description: 'Lookup', parameters: {}, imports: [] } } }) }],
    ['duplicate aliases', b => { b.files['skills/other/SKILL.md'] = skill({ name: 'other' }); b.files['skills/other/lookup.js'] = 'export default 2' }],
  ]
  for (const name of ['exec', 'write', 'invoke_tool', 'message', 'session', 'subagent', 'project_config', 'arbitrary']) {
    mutations.push([`forbidden tool ${name}`, b => { b.files['agents/helper/AGENT.md'] = agent({ allowedTools: [name] }) }])
  }
  for (const [label, mutate] of mutations) {
    const invalid = bundle()
    mutate(invalid)
    const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: invalid })
    assert.equal(store.validate().valid, false, label)
    await assert.rejects(store.publish(draft.revision), /Invalid resource draft/, label)
    assert.deepEqual(store.snapshot(), active, label)
    assert.deepEqual(new AgentResourceStore(options).snapshot(), active, label)
  }
})

test('unsafe paths, structural data and oversized bundles are rejected at staging', async t => {
  const { store } = fixture(t)
  const active = await publish(store)
  for (const path of [
    '/agents/helper/AGENT.md', 'agents/../AGENT.md', 'agents\\helper\\AGENT.md',
    'agents/Helper/AGENT.md', 'agents/helper/agent.md', 'agents/helper/AGENT.md/extra',
    'skills/catalog/Lookup.js', 'skills/catalog/lookup.mjs', 'skills/catalog/../lookup.js',
    'C:/agents/helper/AGENT.md', 'skills/catalog/foo%2ejs', 'skills/catalog//lookup.js',
  ]) {
    const invalid = bundle()
    invalid.files[path] = 'not supported'
    await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: invalid }), /resource path/, path)
  }
  const invalid = bundle()
  invalid.files['skills/catalog/lookup.js'] = 'é'.repeat(256_001)
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: invalid }), /size limit/)
  const oversized = bundle()
  for (let i = 0; i < 10; i++) oversized.files[`skills/catalog/source${i}.js`] = 'x'.repeat(500_000)
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: oversized }), /size limit/)
  const nonJson = bundle()
  nonJson.bindings[0].parameters.value = new Date()
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: nonJson }), /plain JSON/)
  nonJson.bindings[0].parameters.value = Infinity
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: nonJson }), /finite/)
  nonJson.bindings[0].parameters.value = Array(2)
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: nonJson }), /dense JSON array/)
  nonJson.bindings[0].parameters.value = JSON.parse('{"__proto__":{"polluted":true}}')
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: nonJson }), /Unsafe JSON property/)
  const badGrant = bundle()
  badGrant.bindings[0].grants = [{ id: 'catalog-api', kind: 'http', origin: 'http://catalog.example', routes: [{ method: 'GET', path: '/' }] }]
  await assert.rejects(store.stage({ expectedRevision: store.draft().revision, bundle: badGrant }), /HTTPS/)
  assert.deepEqual(store.snapshot(), active)
  assert.deepEqual(store.draft(), active)
})

test('tool and HTTP body schemas reject unsupported keywords and excessive nesting before publication', async t => {
  const { store, options } = fixture(t)
  const active = await publish(store)
  const history = store.history()
  let deep: Record<string, unknown> = { type: 'string' }
  for (let i = 0; i < 33; i++) deep = { type: 'array', items: deep }
  const schemas: Array<[string, Record<string, unknown>]> = [
    ['regex', { type: 'object', properties: { text: { type: 'string', pattern: '(a+)+$' } } }],
    ['pattern properties', { type: 'object', patternProperties: { '.*': { type: 'string' } } }],
    ['reference', { type: 'object', $ref: 'https://example.invalid/schema' }],
    ['combinator', { type: 'object', allOf: [{ required: ['value'] }] }],
    ['nested combinator', { type: 'object', properties: { value: { anyOf: [{ type: 'string' }] } } }],
    ['schema additional properties', { type: 'object', additionalProperties: { type: 'string' } }],
    ['tuple items', { type: 'object', properties: { values: { type: 'array', items: [{ type: 'string' }] } } }],
    ['multiple types', { type: 'object', properties: { value: { type: ['string', 'null'] } } }],
    ['nesting limit', { type: 'object', properties: { value: deep } }],
  ]
  for (const target of ['tool', 'route']) {
    for (const [label, schema] of schemas) {
      const authored = bundle()
      if (target === 'tool') {
        authored.files['skills/catalog/SKILL.md'] = skill({ tools: {
          lookup: { source: 'lookup.js', description: 'Lookup', parameters: schema, imports: [] },
        } })
      } else {
        const grant = authored.bindings[0].grants[0]
        assert.equal(grant.kind, 'http')
        if (grant.kind === 'http') grant.routes[0].bodySchema = schema
      }
      const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
      const validation = store.validate()
      assert.equal(validation.valid, false, `${target}: ${label}`)
      assert.match(validation.errors.join('; '), /schema|properties/i, `${target}: ${label}`)
      assert.throws(() => store.preview(address), /schema|properties/i)
      await assert.rejects(store.publish(draft.revision), /Invalid resource draft/)
      assert.deepEqual(store.snapshot(), active)
      assert.deepEqual(store.history(), history)
      assert.deepEqual(new AgentResourceStore(options).snapshot(), active)
    }
  }
})

test('tool parameters require an explicit object root', async t => {
  const { store } = fixture(t)
  const active = await publish(store)
  for (const parameters of [{}, { type: 'string' }, { type: 'array', items: { type: 'string' } }]) {
    const authored = bundle()
    authored.files['skills/catalog/SKILL.md'] = skill({ tools: {
      lookup: { source: 'lookup.js', description: 'Lookup', parameters, imports: [] },
    } })
    const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
    assert.match(store.validate().errors.join('; '), /parameters must have type object/)
    await assert.rejects(store.publish(draft.revision), /parameters must have type object/)
    assert.deepEqual(store.snapshot(), active)
  }
})

test('supported schema subset remains publishable for tools and HTTP bodies', async t => {
  const { store } = fixture(t)
  const schema = {
    type: 'object', title: 'Input', description: 'Safe schema subset',
    $schema: 'https://json-schema.org/draft-07/schema#',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 20, enum: ['hello'] },
      count: { type: 'integer', minimum: 0, maximum: 10 },
      value: { type: 'number', const: 0.5 },
      enabled: { type: 'boolean' },
      absent: { type: 'null' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    },
    required: ['text'], additionalProperties: false,
  }
  const authored = bundle()
  authored.files['skills/catalog/SKILL.md'] = skill({ tools: {
    lookup: { source: 'lookup.js', description: 'Lookup', parameters: schema, imports: ['@shadow/catalog-api'] },
  } })
  const grant = authored.bindings[0].grants[0]
  if (grant.kind === 'http') grant.routes[0].bodySchema = schema
  const active = await publish(store, authored)
  assert.equal(store.validate().valid, true)
  assert.deepEqual(store.preview(address)!.tools[0].parameters, schema)
  assert.equal(store.resolve(address)!.revision, active.revision)
})

test('tool source accepts exactly 256 KiB UTF-8 and rejects one extra byte before publication', async t => {
  const { store, options } = fixture(t)
  const limit = 256 * 1024
  const prefix = 'export async function run() { return "ok"; }\n//'
  for (const character of ['x', 'é']) {
    const remaining = limit - Buffer.byteLength(prefix, 'utf8')
    const width = Buffer.byteLength(character, 'utf8')
    const code = prefix + character.repeat(Math.floor(remaining / width)) + ' '.repeat(remaining % width)
    assert.equal(Buffer.byteLength(code, 'utf8'), limit)
    const authored = bundle()
    authored.files['skills/catalog/lookup.js'] = code
    const active = await publish(store, authored)
    assert.equal(store.validate().valid, true)
    assert.equal(store.preview(address)!.tools[0].code, code)
    const history = store.history()
    authored.files['skills/catalog/lookup.js'] += 'x'
    assert.equal(Buffer.byteLength(authored.files['skills/catalog/lookup.js'], 'utf8'), limit + 1)
    const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
    assert.match(store.validate().errors.join('; '), /262144-byte restricted runtime limit/)
    assert.throws(() => store.preview(address), /262144-byte restricted runtime limit/)
    await assert.rejects(store.publish(draft.revision), /262144-byte restricted runtime limit/)
    assert.deepEqual(store.snapshot(), active)
    assert.deepEqual(store.history(), history)
    assert.deepEqual(new AgentResourceStore(options).snapshot(), active)
  }
})

test('removed and disabled groups remain managed through history pruning and restarts', async t => {
  const { store, options } = fixture(t)
  const first = await publish(store)
  const disabled = bundle()
  disabled.bindings[0].enabled = false
  await publish(store, disabled)
  assert.equal(store.resolve(address), undefined)
  assert.equal(store.isManaged(address), true)
  const removed = bundle()
  removed.bindings = []
  await publish(store, removed)
  for (let i = 0; i < 22; i++) {
    removed.files['skills/catalog/lookup.js'] = `export async function run() { return ${i}; }`
    await publish(store, removed)
  }
  assert.equal(store.history().length, 20)
  assert.equal(store.history().some(item => item.revision === first.revision), false)
  assert.equal(store.isManaged(address), true)
  assert.equal(store.resolve(address), undefined)
  const restarted = new AgentResourceStore(options)
  assert.equal(restarted.isManaged(address), true)
  await assert.rejects(restarted.rollback(first.revision, restarted.snapshot().revision), /pruned/)
})

test('strict bot, platform and project isolation; empty tools and explicit instructions work', async t => {
  const { store, options } = fixture(t)
  const authored = bundle()
  authored.files['agents/helper/AGENT.md'] = agent({ allowedTools: [], soul: true })
  await publish(store, authored)
  assert.deepEqual(store.resolve(address)!.agent.allowedTools, [])
  assert.equal(store.resolve(address)!.agent.soul, false)
  assert.equal(store.resolve(address)!.skillPrompts.length, 1)
  for (const foreign of [
    { ...address, projectId: 'other-project' }, { ...address, botInstanceId: 'other-bot' },
    { ...address, platform: 'discord' }, { ...address, conversationId: 'other-group' },
  ]) {
    assert.equal(store.resolve(foreign), undefined)
    assert.equal(store.isManaged(foreign), false)
  }
  assert.throws(() => new AgentResourceStore({ ...options, projectId: 'other-project' }), /another project/)
  authored.files['agents/general/AGENT.md'] = agent({ name: 'general', allowedTools: [] })
  const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: authored })
  await assert.rejects(store.publish(draft.revision), /Builtin agent name/)
})

test('complete publication is atomic and failed persistence preserves memory and history', async t => {
  const { store, directory, options } = fixture(t)
  const first = await publish(store)
  const changed = bundle()
  changed.files['skills/catalog/lookup.js'] = 'export async function run() { return "new code"; }'
  changed.bindings[0].parameters.greeting = 'new binding'
  const draft = await store.stage({ expectedRevision: store.draft().revision, bundle: changed })
  const file = join(directory, 'resources.json')
  const before = readFileSync(file, 'utf8')
  rmSync(file)
  mkdirSync(file)
  await assert.rejects(store.publish(draft.revision), /storage boundary/)
  assert.deepEqual(store.snapshot(), first)
  assert.equal(store.history().length, 1)
  rmSync(file, { recursive: true })
  writeFileSync(file, before)
  await store.publish(draft.revision)
  const restarted = new AgentResourceStore(options)
  assert.equal(restarted.resolve(address)!.tools[0].code, changed.files['skills/catalog/lookup.js'])
  assert.equal(restarted.resolve(address)!.binding.parameters.greeting, 'new binding')
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(persisted.published, persisted.history.at(-1))
})

test('existing documents fail closed on tampering and stale store instances cannot overwrite', async t => {
  const { store, options, directory } = fixture(t)
  const stale = new AgentResourceStore(options)
  await publish(store)
  await assert.rejects(stale.stage({ expectedRevision: stale.draft().revision, bundle: bundle() }), /changed externally/)
  const file = join(directory, 'resources.json')
  const original = readFileSync(file, 'utf8')
  for (const mutate of [
    (doc: any) => { doc.published.bundle.files['skills/catalog/lookup.js'] = 'tampered' },
    (doc: any) => { doc.managed = [] },
    (doc: any) => { doc.history = [] },
    (doc: any) => { doc.extra = true },
    (doc: any) => { doc.managed.push('not-json') },
  ]) {
    const doc = JSON.parse(original)
    mutate(doc)
    writeFileSync(file, JSON.stringify(doc))
    assert.throws(() => new AgentResourceStore(options))
  }
  writeFileSync(file, '{not-json')
  assert.throws(() => new AgentResourceStore(options))
})

test('symlink storage directories are rejected', t => {
  const { directory } = fixture(t)
  const target = join(directory, 'target')
  const linked = join(directory, 'linked')
  mkdirSync(target)
  symlinkSync(target, linked, 'junction')
  assert.throws(() => new AgentResourceStore({ projectId: address.projectId, directory: linked }), /Symlink/)
})
