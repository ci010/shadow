// Run after pnpm build:app: electron desktop/tests/fixtures/production-animation-smoke.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
async function main() {
  await app.whenReady()
  const assets = path.resolve(process.argv[2] || 'app/dist/assets')
  const file = fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
  assert.ok(file, 'Production CSS required: run pnpm build:app first')
  const css = fs.readFileSync(path.join(assets, file), 'utf8')
  const scope = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = css.match(new RegExp(escaped + '\\[data-v-([a-f0-9]+)\\]'))
    assert.ok(match, `Missing production selector ${selector}`)
    return `data-v-${match[1]}`
  }
  const window = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent(`<div class="composer-box composer-working" ${scope('.composer-box')}></div><div class="activity-spinner" ${scope('.activity-spinner')}></div><span class="working-wave"><i ${scope('.working-wave i')}></i></span><div class="animate-spin"></div>`))
    await window.webContents.insertCSS(css)
    const result = await window.webContents.executeJavaScript(`(async () => {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced) return { reduced }
      const results = []
      for (const selector of ['.composer-box', '.activity-spinner', '.working-wave i', '.animate-spin']) {
        const el = document.querySelector(selector)
        const name = getComputedStyle(el).animationName
        const animation = el.getAnimations().find(a => a.animationName === name)
        if (!animation) { results.push({selector, name, missing: true}); continue }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const beforeTime = animation.currentTime
        await new Promise(resolve => setTimeout(resolve, 200))
        const advances = animation.currentTime > beforeTime
        animation.pause()
        const duration = animation.effect.getTiming().duration
        const property = selector === '.composer-box' ? 'boxShadow' : 'transform'
        const samples = [0, duration / 6, duration / 3, duration / 2, duration * 2 / 3, duration * 5 / 6, duration].map(time => {
          animation.currentTime = time
          return getComputedStyle(el)[property]
        })
        results.push({selector, name, duration, advances, samples, frames: animation.effect.getKeyframes().length})
      }
      return {reduced, results}
    })()`)
    assert.equal(result.reduced, false, 'Verification requires no reduced motion; do not override user preferences')
    for (const entry of result.results) {
      assert.equal(entry.missing, undefined, `${entry.selector}: ${entry.name} must resolve to keyframes`)
      assert.ok(entry.advances, `${entry.selector} playback clock must advance`)
      assert.ok(entry.frames >= 2)
      assert.notEqual(entry.samples[0], entry.samples[3], `${entry.selector} rendered property must change`)
    }
    const composer = result.results[0]
    assert.equal(composer.duration, 9000)
    assert.equal(new Set(composer.samples.slice(0, 6)).size, 6, 'Preserve three color peaks and troughs')
    assert.equal(composer.samples[0], composer.samples[6])
    await window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reduced = await window.webContents.executeJavaScript(`['.composer-box','.working-wave i'].map(s => getComputedStyle(document.querySelector(s)).animationName)`)
    assert.deepEqual(reduced, ['none', 'none'], 'Retain reduced-motion accessibility')
    console.log('PRODUCTION_ANIMATION_OK', JSON.stringify({ file, ...result }))
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
