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

test('all file icon mappings generate locally with their original SVG colors', async () => {
  const source = await readFile(new URL('./file-icons.ts', import.meta.url), 'utf8')
  const icons = new Set([...source.matchAll(/\bi-material-icon-theme-[a-z0-9-]+/g)].map(match => match[0]))
  assert.ok(icons.size > 0)
  const generator = await createGenerator(config)
  const result = await generator.generate(source, { preflights: false })
  for (const icon of icons) assert.ok(result.matched.has(icon), `${icon} must be extracted and generated`)
  assert.equal([...result.css.matchAll(/background(?:-image)?:url\("data:image\/svg\+xml/g)].length, icons.size)
  assert.ok(/fill='%23[0-9a-f]+/i.test(result.css), 'SVG fill colors must be preserved')
  assert.doesNotMatch(result.css, /(?:mask:|mask-image:|background-color:currentColor)/)
  assert.doesNotMatch(result.css, /url\(["']?https?:/)
})
