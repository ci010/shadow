import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { splitToolPayloadSource } from './tool-payload-source.ts'
import { highlightFile } from './file-highlighting.ts'

test('read pagination footers stay outside syntax highlighting and preserve exact source', async () => {
  for (const newline of ['\n', '\r\n']) {
    for (const numbered of [false, true]) {
      const code = [
        '    this.#commit({ ...this.#current(), folders: [...this.#current().folders, folder] })',
        '    return { ...folder }',
        '  })',
        '}',
        'remoteClaims(nodeId?: string): RemoteOwnershipClaim[] {',
        '  return structuredClone((this.#current().remoteClaims ?? []).filter(claim => !nodeId || claim.workdir.nodeId === nodeId))',
        '}',
        'async update(projectId: string, refs: readonly WorkdirRefV1[]): Promise<void> {',
        '  this.#mutex.run(() => {',
      ].map((line, index) => numbered ? `${index + 310}  ${line}` : line).join(newline)
      for (const message of [
        '[truncated: showing lines 310–434 of 517 — use offset=435 to read more]',
        '[truncated: showing lines 310-434 of 517; use offset=435 to continue]',
      ]) {
        const footer = newline + newline + message
        const source = code + footer
        const split = splitToolPayloadSource(source)
        assert.deepEqual(split, { code, footer })
        const tokens = await highlightFile(split.code, 'catalog.ts', { lineNumbers: numbered })
        assert.equal(tokens.map(token => token.text).join('') + split.footer, source)
        assert.ok(tokens.some(token => token.light && token.dark))
        assert.ok(!tokens.some(token => token.text.includes('[truncated:')))
      }
    }
  }
})

test('ordinary code and non-footer truncation-like text are unchanged', () => {
  for (const source of ['', 'const value = 1', '[truncated: read more]',
    'code\n\n[truncated: showing lines 1–2 of 3 — use offset=3 to read more]\nmore code',
    'const value = "[truncated: showing lines 1–2 of 3 — use offset=3 to read more]"']) {
    assert.deepEqual(splitToolPayloadSource(source), { code: source, footer: '' })
  }
})

test('tool payload passes only code to Shiki and renders footer as plain selectable text', () => {
  const component = readFileSync(new URL('./components/ToolPayload.vue', import.meta.url), 'utf8')
  assert.match(component, /:source="highlightSource\.code"/)
  assert.match(component, /<span v-if="highlightSource\.footer" class="payload-footer">\{\{ highlightSource\.footer \}\}<\/span>/)
})
