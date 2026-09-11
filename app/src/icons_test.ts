import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createGenerator } from 'unocss'
import config from '../unocss.config.ts'

test('all literal UI icons and brand icons generate locally as currentColor CSS masks', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const icons = new Set(['i-lucide-folder-open', 'i-simple-icons-github', 'i-simple-icons-gitlab'])
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.vue')) continue
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8')
    for (const match of source.matchAll(/\bi-(?:lucide|simple-icons)-[a-z0-9-]+/g)) icons.add(match[0])
  }
  const generator = await createGenerator(config)
  const result = await generator.generate([...icons].join(' '), { preflights: false })
  assert.deepEqual([...result.matched].sort(), [...icons].sort())
  assert.match(result.css, /data:image\/svg\+xml/)
  assert.match(result.css, /background-color:currentColor/)
  assert.doesNotMatch(result.css, /url\(["']?https?:/)
})
