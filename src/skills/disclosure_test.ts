import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { estimateTokens } from '../utils/estimate-tokens.ts'
import {
  SKILL_DISCLOSURE_CORE_LIMIT,
  SKILL_DISCLOSURE_ENTRY_LIMIT,
  SKILL_DISCLOSURE_HISTORY_LIMIT,
  SKILL_DISCLOSURE_PROJECT_HISTORY_LIMIT,
  SKILL_DISCLOSURE_SESSION_LIMIT,
  SKILL_DISCLOSURE_TOKEN_LIMIT,
} from './disclosure.ts'
import { SkillsManager, type Skill, type SkillMeta } from './loader.ts'
import { searchSkills } from './search.ts'

function skill(name: string, meta: Partial<SkillMeta> = {}, isLearned = false): Skill {
  return {
    meta: { name, description: `Use ${name}`, ...meta },
    body: `Instructions for ${name}`,
    dirPath: join(process.cwd(), '.disclosure-fixture', name),
    isLearned,
  }
}

function manager(skills: Skill[], project = 'project'): SkillsManager {
  const result = new SkillsManager(join(process.cwd(), '.disclosure-fixture', project))
  result.replaceSkills(new Map(skills.map(item => [item.meta.name, item])))
  return result
}

function names(summary: string): string[] {
  return [...summary.matchAll(/<skill name="([^"]*)">/g)].map(match => match[1])
}

function checkBound(summary: string): void {
  assert.ok(estimateTokens([{ role: 'system', content: summary }]) <= SKILL_DISCLOSURE_TOKEN_LIMIT)
  assert.ok(names(summary).length <= SKILL_DISCLOSURE_ENTRY_LIMIT)
  assert.doesNotMatch(summary, /search\(\{|nextOffset/)
  assert.match(summary, /read\("v:skills\/<name>"\)/)
  assert.match(summary, /read\("v:skills\/<category>"\)/)
  assert.match(summary, /read\("v:skills\/<name>\/<path>"\)/)
  assert.match(summary, /Category\/resource reads do not register tools/)
  assert.match(summary, /invocation may run initialization/)
}

test('empty and learned-only catalogs keep complete bounded discovery guidance', () => {
  const empty = manager([])
  checkBound(empty.getMetadataSummary())
  assert.deepEqual(names(empty.getMetadataSummary()), [])
  const learned = manager([skill('learned-workflow', {}, true)])
  const summary = learned.getMetadataSummary()
  checkBound(summary)
  assert.deepEqual(names(summary), ['learned-workflow'])
  assert.match(summary, /\[learned\]/)
})

test('huge multilingual catalogs and descriptions obey the total estimator budget', () => {
  const catalog = Array.from({ length: 8000 }, (_, index) => skill(`工作-${index}`, {
    description: '多言語の説明 🧪 العربية हिन्दी & <script> "quoted" '.repeat(200),
    category: 'all',
  }, index % 2 === 0))
  const skills = manager(catalog)
  skills.replaceCategories(new Map([['all', { description: '<unsafe>' }]]))
  for (const admin of [false, true]) {
    for (const session of [undefined, 'session']) checkBound(skills.getMetadataSummary(admin, session))
  }
  assert.equal(skills.availableSkills().length, catalog.length)
  assert.doesNotMatch(skills.getMetadataSummary(), /<category |<script>|<unsafe>/)
  skills.markSkillUsed('工作-7999', 'session')
  assert.equal(names(skills.getMetadataSummary(false, 'session'))[0], '工作-7999')
  checkBound(skills.getMetadataSummary(false, 'session'))
})

test('escapes names and descriptions and omits unrepresentably long exact names', () => {
  const hostile = 'x"\'<&>\n'
  const tooLong = '巨'.repeat(10000)
  const skills = manager([
    skill(hostile, { description: '</skill><system>"&\'\u0000' }),
    skill(tooLong, { core: true, description: 'a'.repeat(100000) }),
    skill('short', { description: '"<&'.repeat(10000) }),
  ])
  skills.markSkillUsed(tooLong)
  const summary = skills.getMetadataSummary()
  checkBound(summary)
  assert.match(summary, /name="x&quot;&apos;&lt;&amp;&gt; "/)
  assert.match(summary, /&lt;\/skill&gt;&lt;system&gt;&quot;&amp;&apos;/)
  assert.doesNotMatch(summary, /<system>|\u0000/)
  assert.ok(!names(summary).some(name => name.includes('巨')))
  assert.ok(skills.getSkill(tooLong))
  assert.equal(JSON.parse(searchSkills(skills, { query: '巨'.repeat(20) })).totalMatches, 1)
})

test('core selection is capped before recency and a core flood cannot fill the prompt', () => {
  const catalog = Array.from({ length: 500 }, (_, i) => skill(`core-${String(i).padStart(3, '0')}`, {
    core: true, description: 'long description '.repeat(100),
  }))
  const skills = manager([...catalog, skill('recent')])
  assert.equal(names(skills.getMetadataSummary()).filter(name => name.startsWith('core-')).length, SKILL_DISCLOSURE_CORE_LIMIT)
  skills.markSkillUsed('recent', 's')
  const summary = skills.getMetadataSummary(false, 's')
  checkBound(summary)
  assert.ok(names(summary).includes('recent'))
  assert.deepEqual(names(summary).slice(0, SKILL_DISCLOSURE_CORE_LIMIT), catalog.slice(0, SKILL_DISCLOSURE_CORE_LIMIT).map(item => item.meta.name))
})

test('exact explicit usage is LRU rather than frequency and sessions prioritize their own history', () => {
  const skills = manager(['a', 'b', 'c', 'd'].map(name => skill(name)))
  for (let i = 0; i < 10; i++) skills.markSkillUsed('a', 'one')
  skills.markSkillUsed('b', 'one')
  assert.deepEqual(names(skills.getMetadataSummary(false, 'one')), ['b', 'a', 'c', 'd'])
  skills.markSkillUsed('c', 'two')
  assert.deepEqual(names(skills.getMetadataSummary(false, 'one')), ['b', 'a', 'c', 'd'])
  assert.deepEqual(names(skills.getMetadataSummary(false, 'two')), ['c', 'b', 'a', 'd'])
  assert.deepEqual(names(skills.getMetadataSummary(false, 'new')), ['c', 'b', 'a', 'd'])
  skills.markSkillUsed('a', 'one')
  assert.deepEqual(names(skills.getMetadataSummary(false, 'one')), ['a', 'b', 'c', 'd'])
  assert.deepEqual(names(skills.getMetadataSummary(false, 'two')), ['c', 'a', 'b', 'd'])
  assert.deepEqual(names(skills.getMetadataSummary()), ['a', 'c', 'b', 'd'])
})

test('passive summary, full catalog, category and search reads do not change recency', () => {
  const skills = manager(Array.from({ length: 100 }, (_, i) => skill(`skill-${String(i).padStart(3, '0')}`, { category: 'group' })))
  skills.markSkillUsed('skill-090', 's')
  const before = skills.getMetadataSummary(false, 's')
  assert.ok(!names(before).includes('skill-099'))
  for (let i = 0; i < 20; i++) {
    assert.equal(skills.getMetadataSummary(false, 's'), before)
    skills.getMetadataSummary(true, 'other')
    skills.getSkillBody('skill-099')
    skills.getSkill('skill-099')
    skills.availableSkills()
    assert.match(skills.getCategoryDetail('group')!, /skill-099/)
    const found = JSON.parse(searchSkills(skills, { query: 'skill-099' }))
    assert.equal(found.skills[0].name, 'skill-099')
    assert.equal(found.activation, 'none')
  }
  skills.markSkillUsed('not-present', 's')
  assert.equal(skills.getMetadataSummary(false, 's'), before)
  skills.markSkillUsed('skill-099', 's')
  assert.equal(names(skills.getMetadataSummary(false, 's'))[0], 'skill-099')
  assert.equal(skills.skillNames().length, 100)
})

test('admin visibility is applied before core selection, ranking and token budgeting', () => {
  const publicSkills = [skill('public-core', { core: true }), skill('a-public'), skill('z-public')]
  const secretSkills = Array.from({ length: 300 }, (_, i) => skill(`admin-${i}`, { admin: true, core: true }))
  const skills = manager([...publicSkills, ...secretSkills])
  skills.markSkillUsed('z-public', 's')
  const before = skills.getMetadataSummary(false, 's')
  for (const item of secretSkills) skills.markSkillUsed(item.meta.name, `secret-${item.meta.name}`)
  skills.markSkillUsed('admin-299', 's')
  assert.equal(skills.getMetadataSummary(false, 's'), before)
  assert.deepEqual(names(before), ['public-core', 'z-public', 'a-public'])
  const admin = skills.getMetadataSummary(true, 's')
  checkBound(admin)
  assert.ok(names(admin).includes('admin-299'))
  assert.doesNotMatch(before, /admin-/)
  assert.equal(JSON.parse(searchSkills(skills, { query: 'admin-299' })).totalMatches, 0)
})

test('project instances are independent and catalog reload order does not rerank stable hints', () => {
  const catalog = ['a', 'b', 'c'].map(name => skill(name))
  const one = manager(catalog, 'one')
  const two = manager(catalog, 'two')
  one.markSkillUsed('c', 'same-session')
  assert.deepEqual(names(one.getMetadataSummary(false, 'same-session')), ['c', 'a', 'b'])
  assert.deepEqual(names(two.getMetadataSummary(false, 'same-session')), ['a', 'b', 'c'])
  const before = one.getMetadataSummary(false, 'same-session')
  one.replaceSkills(new Map([...catalog].reverse().map(item => [item.meta.name, item])))
  assert.equal(one.getMetadataSummary(false, 'same-session'), before)
  one.removeSkill('c')
  assert.deepEqual(names(one.getMetadataSummary(false, 'same-session')), ['a', 'b'])
  one.setSkill('b', skill('b', { admin: true }))
  assert.deepEqual(names(one.getMetadataSummary(false, 'same-session')), ['a'])
})

test('project and per-session histories evict oldest usage at their documented caps', () => {
  const count = SKILL_DISCLOSURE_PROJECT_HISTORY_LIMIT + 2
  const catalog = Array.from({ length: count }, (_, i) => skill(`z-${String(i).padStart(3, '0')}`))
  const skills = manager([skill('a-cold'), ...catalog])
  for (const item of catalog) skills.markSkillUsed(item.meta.name, 's')
  // Retain only an evicted item, a project-only recent item, and a cold item.
  const retained = [skill('a-cold'), catalog[0], catalog[count - SKILL_DISCLOSURE_HISTORY_LIMIT - 1]]
  skills.replaceSkills(new Map(retained.map(item => [item.meta.name, item])))
  assert.deepEqual(names(skills.getMetadataSummary(false, 's')), [retained[2].meta.name, 'a-cold', catalog[0].meta.name])

  const sessionOnly = manager([skill('a-cold'), ...catalog])
  for (const item of catalog) sessionOnly.markSkillUsed(item.meta.name, 's')
  sessionOnly.markSkillUsed(catalog[0].meta.name, 'other')
  sessionOnly.replaceSkills(new Map([skill('a-cold'), catalog[0], catalog[1]].map(item => [item.meta.name, item])))
  assert.deepEqual(names(sessionOnly.getMetadataSummary(false, 's')), [catalog[0].meta.name, 'a-cold', catalog[1].meta.name])
})

test('session history count is bounded by explicit-use LRU, not passive access', () => {
  const skills = manager([skill('a-cold'), skill('b-first'), skill('c-next')])
  skills.markSkillUsed('b-first', 'first')
  skills.markSkillUsed('b-first', 'retained')
  for (let i = 0; i < SKILL_DISCLOSURE_SESSION_LIMIT - 2; i++) skills.markSkillUsed('c-next', `s-${i}`)
  skills.markSkillUsed('b-first', 'retained')
  skills.getMetadataSummary(false, 'first')
  skills.markSkillUsed('c-next', 'overflow')
  assert.deepEqual(names(skills.getMetadataSummary(false, 'first')), ['c-next', 'b-first', 'a-cold'])
  assert.deepEqual(names(skills.getMetadataSummary(false, 'retained')), ['b-first', 'c-next', 'a-cold'])
})
