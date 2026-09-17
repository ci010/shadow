import assert from 'node:assert/strict'
import test from 'node:test'
import { draftSettingsKey, loadDraftSettings, saveDraftSettings } from './draft-settings.ts'
import { updateSessionSettings } from './session-settings.ts'

test('draft choices survive reload and remain isolated by installation, project, folder and remote draft', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const key = draftSettingsKey('http://fixture', 'one')
  const settings = { model: 'gpt-6-astra@copilot', reasoningEffort: 'medium' as const }
  saveDraftSettings(storage, key, settings)
  assert.deepEqual(loadDraftSettings(storage, key), settings)
  for (const other of [
    draftSettingsKey('http://other', 'one'), draftSettingsKey('http://fixture', 'two'),
    draftSettingsKey('http://fixture', 'one', 'folder'), draftSettingsKey('http://fixture', 'one', undefined, true),
  ]) assert.equal(loadDraftSettings(storage, other), undefined)
  saveDraftSettings(storage, key, { model: null, thinking: null, reasoningEffort: null })
  assert.deepEqual(loadDraftSettings(storage, key), {})
})

test('invalid drafts and storage failures are surfaced rather than silently discarded', () => {
  for (const text of ['{', '[]', '{"reasoningEffort":"invalid"}', '{"model":3}', '{"model":""}', '{"providers":{}}']) {
    assert.throws(() => loadDraftSettings({ getItem: () => text }, 'fixture'))
  }
  assert.throws(() => saveDraftSettings({ setItem: () => { throw new Error('Storage unavailable') } }, 'fixture', {}), /Storage unavailable/)
})

test('conversation model selections persist without a provider turn and can be cleared to inherit', async () => {
  for (const model of ['gpt-6-astra@copilot', null]) {
    const result = await updateSessionSettings('http://fixture/projects/one/', 'web:chat-one', { model },
      new AbortController().signal, async (url, init) => {
        assert.equal(String(url), 'http://fixture/projects/one/api/sessions/web%3Achat-one/config')
        assert.equal(init?.method, 'PATCH')
        assert.deepEqual(JSON.parse(String(init.body)), { model })
        return Response.json({ key: 'web:chat-one', config: { ...(model ? { model } : {}), reasoningEffort: 'medium' } })
      })
    assert.equal(result.model, model ?? undefined)
    assert.equal(result.reasoningEffort, 'medium')
  }
})
