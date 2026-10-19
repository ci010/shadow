import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { decodeReadText } from './read-text.ts'
import type { ExecutionContext } from './context.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import type { JobRequestV1 } from '../execution/contracts.ts'

test('strict decoding tolerates only cap-induced incomplete characters', () => {
  const cap = 256 * 1024
  for (const char of ['é', '中', '😀']) {
    const encoded = Buffer.from(char)
    for (let tail = 1; tail < encoded.length; tail++) {
      const prefix = Buffer.alloc(cap - tail, 97)
      const all = Buffer.concat([prefix, encoded, Buffer.from('end')])
      assert.equal(decodeReadText(all.subarray(0, cap), 'auto', true).content, prefix.toString())
      assert.throws(() => decodeReadText(all.subarray(0, cap), 'auto', false), /Retry read/)
    }
  }
  assert.throws(() => decodeReadText(Buffer.from([0xff, 97]), 'auto', true), /Retry read/)
  assert.throws(() => decodeReadText(Buffer.from([0x81]), 'gb18030', false), /Retry read/)
})

test('BOM detection, strict legacy opt-in and binary rejection', () => {
  assert.equal(decodeReadText(Buffer.from('\ufeff中'), 'auto', false).content, '中')
  const le = Buffer.from('\ufeff中\n文', 'utf16le')
  for (const [bytes, encoding] of [[le, 'utf-16le'], [Buffer.from(le).swap16(), 'utf-16be']] as const) {
    assert.deepEqual(decodeReadText(bytes, 'auto', false), { content: '中\n文', encoding })
  }
  const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.throws(() => decodeReadText(gb, 'auto', false), /strict UTF-8/)
  assert.equal(decodeReadText(gb, 'gb18030', false).content, '中文')
  for (const bytes of [Buffer.from([97, 0, 98]), Buffer.from([0xff, 0xfe, 0, 0])]) {
    assert.throws(() => decodeReadText(bytes, 'auto', false), /Binary/)
  }
})

test('ReadTool encoding paging, cache separation, cap and unsupported routes', async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/read-encoding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context = { cwd: root, sessionId: 'encoding', physicalSessionId: 'encoding-0', signal: new AbortController().signal } as ExecutionContext
  const vfs = new VirtualFs()
  vfs.mount('v:fixture', 'fixture', () => 'virtual')
  const reader = new ReadTool(root, vfs)
  for (const [name, bytes, header] of [
    ['bom8.txt', Buffer.from('\ufeffone\ntwo'), ''],
    ['bomle.txt', Buffer.from('\ufeffone\ntwo', 'utf16le'), '[encoding: utf-16le]\n'],
    ['bombe.txt', Buffer.from('\ufeffone\ntwo', 'utf16le').swap16(), '[encoding: utf-16be]\n'],
  ] as const) {
    await writeFile(join(root, name), bytes)
    assert.equal(await reader.execute({ path: name, offset: 2, limit: 1, flag: 'n' }, context), header + '2  two')
  }
  await writeFile(join(root, 'legacy.txt'), Buffer.from([0xd6, 0xd0, 10, 0xce, 0xc4]))
  await assert.rejects(reader.execute({ path: 'legacy.txt' }, context), /Retry read/)
  assert.equal(await reader.execute({ path: 'legacy.txt', encoding: 'gb18030', flag: 'n', offset: 2, limit: 1 }, context), '[encoding: gb18030]\n2  文')
  assert.match(String(await reader.execute({ path: 'legacy.txt', encoding: 'gb18030', flag: 'n', offset: 2, limit: 1 }, context)), /unchanged/i)
  assert.doesNotMatch(String(await reader.execute({ path: 'legacy.txt', encoding: 'windows-1252', offset: 2, limit: 1 }, context)), /unchanged/i)
  await writeFile(join(root, 'large.txt'), Buffer.concat([Buffer.alloc(256 * 1024 - 1, 97), Buffer.from('中\ntail')]))
  assert.match(String(await reader.execute({ path: 'large.txt', offset: 2 }, context)), /truncated/)
  await writeFile(join(root, 'image.png'), 'not actually an image')
  for (const path of ['https://example.invalid', 'v:fixture', '.', 'image.png']) {
    await assert.rejects(reader.execute({ path, encoding: 'auto' }, context), /encoding/)
  }
  await assert.rejects(reader.execute({ path: 'legacy.txt', encoding: 'bogus' }, context), /Unsupported/)
  let called = false
  const remote = { ...context, remoteWorkdir: { executor: { execute() { called = true; throw new Error('unexpected') } } } } as unknown as ExecutionContext
  await assert.rejects(reader.execute({ path: 'legacy.txt', encoding: 'gb18030' }, remote), /No Main filesystem fallback/)
  assert.equal(called, false)
})

test('local edits/appends and capability appends leave non-UTF8 bytes intact', async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/write-encoding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context = { cwd: root, sessionId: 'encoding', physicalSessionId: 'encoding-0', signal: new AbortController().signal } as ExecutionContext
  const writer = new WriteTool(root)
  const fs = new CapabilityFilesystem([{ capabilityId: 'workdir', rootPath: root }])
  for (const bytes of [Buffer.from([0xd6, 0xd0]), Buffer.from('\ufeff中', 'utf16le'), Buffer.from([97, 0, 98])]) {
    await writeFile(join(root, 'text.txt'), bytes)
    for (const args of [{ match: 'a', content: 'b' }, { flag: 'a', content: 'tail' }]) {
      await assert.rejects(writer.execute({ path: 'text.txt', ...args }, context), /requires UTF-8/)
      assert.deepEqual(await readFile(join(root, 'text.txt')), bytes)
    }
    await assert.rejects(fs.execute({ capabilityId: 'workdir', operation: 'filesystem.write', args: { path: 'text.txt', mode: 'append', content: 'tail' } } as JobRequestV1, context.signal), /requires UTF-8/)
    assert.deepEqual(await readFile(join(root, 'text.txt')), bytes)
  }
})
