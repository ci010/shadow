import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkProcessor, testProcessor, readProcessorFile } from './input-processor-authoring.ts'

test('file example: actual restricted runtime and virtual fixed window', async () => {
  const result = await testProcessor(process.cwd(), 'examples/input-processor/processor.ts', 'examples/input-processor/fixtures.json', AbortSignal.timeout(10000))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.outputs, [{ at: 0, ids: ['2'] }, { at: 1000, ids: ['3', '4'] }])
})
test('check rejects dependencies, syntax/type errors and escaped paths; frozen byte snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'processor-'))
  try {
    for (const source of ["import fs from 'node:fs'; export function run(){return fs}", "import type {X} from './dependency.ts'; export function run(){}", 'export function run( {', 'export const run: number = "bad"']) {
      await writeFile(path.join(root, 'p.ts'), source)
      assert.equal((await checkProcessor(root, 'p.ts')).ok, false)
    }
    await assert.rejects(readProcessorFile(root, '../outside.ts'))
    await assert.rejects(readProcessorFile(root, path.join(root, 'p.ts')))
    await writeFile(path.join(root, 'p.ts'), 'export function run(){return {action:"ignore" as const}}')
    const frozen = await checkProcessor(root, 'p.ts')
    await writeFile(path.join(root, 'p.ts'), 'export function run(){return {action:"emit" as const}}')
    assert.match(frozen.source, /ignore/)
    assert.match(frozen.code, /ignore/)
    assert.notEqual(frozen.sha256, (await checkProcessor(root, 'p.ts')).sha256)
    const external = await mkdtemp(path.join(os.tmpdir(), 'processor-outside-'))
    try {
      await writeFile(path.join(external, 'p.ts'), frozen.source)
      await symlink(external, path.join(root, 'link'), 'junction')
      await assert.rejects(readProcessorFile(root, 'link/p.ts'), /outside workspace/)
    } finally { await rm(external, { recursive: true, force: true }) }
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('runtime exception has diagnostic trace, does not publish', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'processor-'))
  try {
    await writeFile(path.join(root, 'p.ts'), 'export function run(): never {throw new Error("fixture failure")}')
    await writeFile(path.join(root, 'f.json'), JSON.stringify({ delayMs: 10, steps: [{ kind: 'input', key: 'k', id: '1', event: {} }] }))
    const result = await testProcessor(root, 'p.ts', 'f.json', AbortSignal.timeout(10000))
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.trace), /error/)
    assert.deepEqual(result.outputs, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('compiler rejects all reference directives and non-callable/incompatible run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'processor-references-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'processor-dependency-'))
  try {
    await writeFile(path.join(outside, 'outside.d.ts'), 'declare const secret: "ignore";')
    await writeFile(path.join(root, 'undeclared.d.ts'), 'declare const local: "ignore";')
    for (const source of [
      `/// <reference path="${path.join(outside, 'outside.d.ts').replaceAll('\\', '/')}" />\nexport function run(){return {action:secret}}`,
      '/// <reference path="undeclared.d.ts" />\nexport function run(){return {action:local}}',
      '/// <reference types="node" />\nexport const run=1',
      '/// <reference lib="dom" />\nexport const run=1',
      'export const run=1',
      'export function run(input: number){return {action:"ignore" as const}}',
      'export function run(){return {action:"invalid" as const}}',
    ]) {
      await writeFile(path.join(root, 'p.ts'), source)
      const checked = await checkProcessor(root, 'p.ts')
      assert.equal(checked.ok, false, source)
      assert.equal(checked.code, '')
      assert.ok(checked.diagnostics.length)
    }
  } finally { await rm(root, {recursive:true,force:true}); await rm(outside, {recursive:true,force:true}) }
})
test('schema resources support complete authoring from a non-repository cwd', async () => {
  const {processorAuthoringGuide} = await import('./input-processor-authoring.ts')
  const root = await mkdtemp(path.join(os.tmpdir(), 'processor-guide-'))
  try {
    const resources = processorAuthoringGuide.resources
    assert.match(resources.documentation, /human approval/)
    assert.match(resources.types, /ProcessorDecision/)
    await writeFile(path.join(root, 'processor.ts'), resources.example)
    await writeFile(path.join(root, 'fixtures.json'), resources.fixtures)
    assert.equal((await checkProcessor(root, 'processor.ts')).ok, true)
    const result = await testProcessor(root, 'processor.ts', 'fixtures.json', AbortSignal.timeout(10000))
    assert.equal(result.ok, true, JSON.stringify(result))
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('multi-file compiler freezes every dependency and executes exactly the bundled artifact', async () => {
  const { executeAuthoredTool } = await import('../agent-authoring/tool-runtime.ts')
  const root = await mkdtemp(path.join(os.tmpdir(), 'processor-graph-'))
  try {
    await writeFile(path.join(root, 'p.ts'), `import type {Processor} from '@shadow/input-processor'; import {action} from './rule.ts'; export const run:Processor = () => ({action:action()});`)
    await writeFile(path.join(root, 'rule.ts'), `export const action = () => 'ignore' as const`)
    const frozen = await checkProcessor(root, 'p.ts')
    assert.equal(frozen.ok, true, JSON.stringify(frozen.diagnostics))
    assert.deepEqual(frozen.snapshot.map(file => file.path), ['p.ts', 'rule.ts'])
    await writeFile(path.join(root, 'rule.ts'), `export const action = () => 'emit' as const`)
    const changed = await checkProcessor(root, 'p.ts')
    assert.equal(changed.ok, true, JSON.stringify(changed.diagnostics))
    assert.notEqual(frozen.sha256, changed.sha256)
    assert.notEqual(frozen.codeSha256, changed.codeSha256)
    const run = (code: string) => executeAuthoredTool({ code, args: {event:{}}, signal: AbortSignal.timeout(5000), callModule: async () => { throw new Error('No grants') } })
    assert.deepEqual(await run(frozen.code), {action:'ignore'})
    assert.deepEqual(await run(changed.code), {action:'emit'})
    await writeFile(path.join(root, 'rule.ts'), `export {readFile as action} from 'node:fs'`)
    assert.equal((await checkProcessor(root, 'p.ts')).ok, false)
  } finally { await rm(root, {recursive:true,force:true}) }
})
