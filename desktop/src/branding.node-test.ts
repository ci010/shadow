import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function assertPng(image: Buffer, size: number): void {
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(image.toString('ascii', 12, 16), 'IHDR')
  assert.equal(image.readUInt32BE(16), size)
  assert.equal(image.readUInt32BE(20), size)
  assert.equal(image[24], 8, 'Logo uses 8-bit color')
  assert.equal(image[25], 6, 'Logo retains RGBA transparency')
}

test('shared logo and browser favicon have transparent, square raster assets', async () => {
  const [logo, favicon, html, ...views] = await Promise.all([
    readFile(new URL('../../app/src/assets/shadow-logo.png', import.meta.url)),
    readFile(new URL('../../app/public/favicon.png', import.meta.url)),
    readFile(new URL('../../app/index.html', import.meta.url)),
    ...['DesktopFrame', 'FirstRunWizard', 'RuntimeRecovery'].map(name =>
      readFile(new URL(`../../app/src/${name}.vue`, import.meta.url))),
  ])
  assertPng(logo!, 512)
  assertPng(favicon!, 64)
  assert.match(html!.toString(), /rel="icon" type="image\/png" sizes="64x64" href="\.\/favicon\.png"/)
  for (const view of views) {
    assert.match(view.toString(), /import shadowLogo from '\.\/assets\/shadow-logo\.png'/)
    assert.match(view.toString(), /<img [^>]*:src="shadowLogo"[^>]*alt=""/)
  }
})

test('Windows icon includes small and high-DPI sizes and ships with the desktop app', async () => {
  const icon = await readFile(new URL('../assets/icon.ico', import.meta.url))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  assert.equal(icon.readUInt16LE(4), sizes.length)
  let offset = 6 + 16 * sizes.length
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + 16 * index
    assert.equal(icon[entry] || 256, size)
    assert.equal(icon[entry + 1] || 256, size)
    assert.equal(icon.readUInt16LE(entry + 4), 1)
    assert.equal(icon.readUInt16LE(entry + 6), 32)
    const length = icon.readUInt32LE(entry + 8)
    assert.equal(icon.readUInt32LE(entry + 12), offset)
    assert.ok(length > 0 && offset + length <= icon.length)
    assertPng(icon.subarray(offset, offset + length), size)
    offset += length
  }
  assert.equal(offset, icon.length)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.build.win.icon, 'assets/icon.ico')
  assert.ok(manifest.build.files.includes('assets/**/*'))
})
