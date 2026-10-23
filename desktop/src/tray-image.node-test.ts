import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeImage } from 'electron'
import { createTrayImage } from './tray.js'

test('macOS tray constrains both production and DEV app icons to menu-bar points', () => {
  for (const path of ['icon.png', 'icon-dev.png']) {
    const resized = {} as NativeImage
    const calls: unknown[] = []
    const images = {
      createFromPath(input: string) {
        calls.push(input)
        return {
          resize(options: unknown) { calls.push(options); return resized },
        } as NativeImage
      },
    }
    assert.equal(createTrayImage(path, images, 'darwin'), resized)
    assert.deepEqual(calls, [path, { width: 18, height: 18, quality: 'best' }])
  }
})

test('other platforms retain native tray image loading and ICO representations', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const images = { createFromPath(): NativeImage { throw new Error('must not decode') } }
    assert.equal(createTrayImage('icon.ico', images, platform), 'icon.ico')
  }
})
