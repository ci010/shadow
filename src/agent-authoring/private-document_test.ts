import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { z } from 'zod'
import { PrivateDocument } from './private-document.ts'

function fixture(t: TestContext) {
  const directory = resolve(`.private-document-test-${randomUUID()}`)
  mkdirSync(directory)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const schema = z.object({ values: z.array(z.string()) }).strict()
  const options = {
    directory, projectId: 'one', filename: 'private.json',
    parse: (value: unknown) => schema.parse(value), initial: { values: [] as string[] },
  }
  return { directory, options, file: join(directory, options.filename), document: new PrivateDocument(options) }
}

test('private documents clone data, persist bounded schema-checked project envelopes and compare disk state', t => {
  const { document, options, file, directory } = fixture(t)
  const competing = new PrivateDocument(options)
  const value = { values: ['first'] }
  document.write(value)
  value.values.push('external')
  document.read().values.push('returned')
  assert.deepEqual(document.read(), { values: ['first'] })
  assert.deepEqual(new PrivateDocument(options).read(), document.read())
  assert.throws(() => competing.write({ values: ['stale'] }), /changed externally/)
  assert.deepEqual(competing.read(), { values: [] })
  assert.deepEqual(readdirSync(directory), ['private.json'])
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text + '\n')
  assert.throws(() => document.write({ values: ['overwrite'] }), /changed externally/)
  assert.equal(readFileSync(file, 'utf8'), text + '\n')
  assert.deepEqual(document.read(), { values: ['first'] })
})

test('invalid schema, oversized results, non-JSON values and serialization failures preserve saved state', t => {
  const { document, options, file } = fixture(t)
  document.write({ values: ['before'] })
  const text = readFileSync(file, 'utf8')
  const limited = new PrivateDocument({ ...options, maxBytes: 256 })
  assert.throws(() => limited.write({ values: ['x'.repeat(512)] }), /size limit/)
  for (const bad of [
    { values: [1] }, { values: [], extra: true }, { values: [undefined] }, { values: [NaN] },
    { values: [new Date()] }, JSON.parse('{"values":[],"__proto__":{}}'),
  ]) assert.throws(() => document.write(bad as { values: string[] }))
  const circular: any = { values: [] }
  circular.values.push(circular)
  assert.throws(() => document.write(circular), /Circular/)
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.deepEqual(document.read(), { values: ['before'] })
})

test('loads reject malformed envelopes, schema violations and wrong projects', t => {
  const { options, file } = fixture(t)
  for (const text of [
    '{broken',
    JSON.stringify({ version: 1, projectId: 'other', value: { values: [] } }),
    JSON.stringify({ version: 2, projectId: 'one', value: { values: [] } }),
    JSON.stringify({ version: 1, projectId: 'one', value: { values: [3] } }),
    JSON.stringify({ version: 1, projectId: 'one', value: { values: [] }, extra: true }),
    '{"version":1,"projectId":"one","value":{"values":[]},"__proto__":{}}',
  ]) {
    writeFileSync(file, text)
    assert.throws(() => new PrivateDocument(options))
  }
  writeFileSync(file, ' '.repeat(300))
  assert.throws(() => new PrivateDocument({ ...options, maxBytes: 256 }), /size limit/)
  assert.throws(() => new PrivateDocument({ ...options, filename: '../escape.json' }), /filename/)
})

test('hardlinked files and symbolic directory ancestors block reads and writes', t => {
  const { options, document, directory, file } = fixture(t)
  document.write({ values: ['original'] })
  const linked = join(directory, 'linked.json')
  linkSync(file, linked)
  assert.throws(() => new PrivateDocument(options), /storage boundary/)
  assert.throws(() => document.write({ values: ['overwrite'] }), /storage boundary/)
  assert.equal(JSON.parse(readFileSync(linked, 'utf8')).value.values[0], 'original')
  rmSync(linked)
  const target = join(directory, 'target')
  mkdirSync(target)
  const alias = join(directory, 'alias')
  symlinkSync(target, alias, 'junction')
  assert.throws(() => new PrivateDocument({ ...options, directory: join(alias, 'new') }), /Symlink/)
  assert.deepEqual(readdirSync(target), [])
})

test('a file replacing the storage directory causes no in-memory write success', t => {
  const { options, directory } = fixture(t)
  const nested = join(directory, 'nested')
  const document = new PrivateDocument({ ...options, directory: nested })
  writeFileSync(nested, 'not a directory')
  assert.throws(() => document.write({ values: ['unsaved'] }), /storage boundary|ENOTDIR/)
  assert.deepEqual(document.read(), { values: [] })
  assert.equal(readFileSync(nested, 'utf8'), 'not a directory')
})

test('assertCurrent checks disk CAS without writes before and after asynchronous work', async t => {
  const { document, options, file, directory } = fixture(t)
  document.assertCurrent()
  assert.deepEqual(readdirSync(directory), [])
  document.write({ values: ['pending'] })
  const before = readFileSync(file, 'utf8')
  document.assertCurrent()
  assert.equal(readFileSync(file, 'utf8'), before)
  const concurrent = new PrivateDocument(options)
  await Promise.resolve().then(() => concurrent.write({ values: ['cancelled'] }))
  assert.throws(() => document.assertCurrent(), /changed externally/)
  assert.deepEqual(document.read(), { values: ['pending'] })
  assert.deepEqual(concurrent.read(), { values: ['cancelled'] })
  concurrent.assertCurrent()
  rmSync(file)
  assert.throws(() => concurrent.assertCurrent(), /changed externally/)
  assert.deepEqual(readdirSync(directory), [])
})

test('assertCurrent rejects newly unsafe storage boundaries without updating cached state', t => {
  const { document, directory, file } = fixture(t)
  document.write({ values: ['pending'] })
  const linked = join(directory, 'linked.json')
  linkSync(file, linked)
  assert.throws(() => document.assertCurrent(), /storage boundary/)
  rmSync(linked)
  document.assertCurrent()
  rmSync(file)
  mkdirSync(file)
  assert.throws(() => document.assertCurrent(), /storage boundary/)
  assert.deepEqual(document.read(), { values: ['pending'] })
})
