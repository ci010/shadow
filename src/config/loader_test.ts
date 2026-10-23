import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { loadConfig } from './loader.ts'

test('loading stored voice settings warns without enabling STT or rewriting the file', async t => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    const original = JSON.stringify({
      agent: { model: 'fixture@openai' },
      voice: { enabled: true, sttUrl: 'http://127.0.0.1:1/private-fixture', timeoutMs: 30000 },
    })
    await writeFile(configPath, original)
    const warnings: string[] = []
    t.mock.method(console, 'warn', (message: string) => warnings.push(message))
    const config = await loadConfig(configPath)
    assert.equal(config.agent.model, 'fixture@openai')
    assert.equal(Object.hasOwn(config, 'voice'), false)
    assert.equal(await readFile(configPath, 'utf8'), original)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /voice.*audio_cpp/)
    assert.doesNotMatch(warnings[0], /private-fixture|127\.0\.0\.1/)
  })
})

test('retired settings do not bypass validation of the remaining stored configuration', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    const original = JSON.stringify({ voice: { enabled: false }, agent: { reasoningEffort: 'invalid' } })
    await writeFile(configPath, original)
    await assert.rejects(loadConfig(configPath), /reasoningEffort/)
    assert.equal(await readFile(configPath, 'utf8'), original)
  })
})
