import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { loadBrowserPinHash } from './browser-pin.ts'

test('optional local PIN is hashed, trims file newline, and rejects invalid files without exposing content', async t => {
  const root = await mkdtemp(resolve('.shadow-test-browser-pin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.pin')
  assert.equal(await loadBrowserPinHash(file), undefined)
  const pin = 'Synthetic-5938'
  await writeFile(file, `${pin}\r\n`)
  assert.equal(await loadBrowserPinHash(file), createHash('sha256').update(pin).digest('hex'))
  for (const invalid of ['', 'abc', 'foo\nbar', 'a'.repeat(513)]) {
    await writeFile(file, invalid)
    await assert.rejects(loadBrowserPinHash(file), /Invalid browser PIN file|Browser PIN must contain/)
  }
  await rm(file)
  await mkdir(file)
  await assert.rejects(loadBrowserPinHash(file), /PIN file/)
})
