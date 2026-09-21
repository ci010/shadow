import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  // Exercise actual Web Audio scheduling without playing sound on the host machine.
  window.webContents.setAudioMuted(true)
  const execute = (code: string) => window.webContents.executeJavaScript(code, true)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const url = new URL('__sounds', process.env.SOUND_SMOKE_URL).href
  try {
    await window.loadURL(url)
    await wait(`!!document.querySelector('.sound-settings')`)
    assert.equal(window.webContents.isAudioMuted(), true)
    await execute(`fixture.sounds.notify('yield'); fixture.sounds.notify('idle')`)
    assert.equal(await execute(`fixture.contexts.length`), 0, 'No AudioContext before user interaction')
    for (const width of [1100, 390]) {
      window.setContentSize(width, 900)
      await delay(50)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
        assert.equal(await execute(`document.querySelector('.settings-navigation [aria-current="page"]').textContent.trim()`), 'Sounds')
        assert.equal(await execute(`[...document.querySelectorAll('.sound-settings button')].every(button =>
          button.getBoundingClientRect().height >= 44 && getComputedStyle(button).borderRadius === '0px')`), true)
        assert.equal(await execute(`[...document.querySelectorAll('.sound-settings input')].every(input => input.labels.length === 1)`), true)
      }
    }
    await execute(`document.querySelector('[aria-label="Preview needs your answer sound"]').click()`)
    await wait(`fixture.tones.length === 2`)
    assert.deepEqual(await execute('fixture.tones'), [659.25, 880])
    assert.equal(await execute('fixture.sounds.ready.value'), true)
    await execute(`document.querySelector('[aria-label="Preview session idle sound"]').click()`)
    await wait(`fixture.tones.length === 4`)
    assert.deepEqual(await execute('fixture.tones.slice(-2)'), [659.25, 523.25])
    assert.equal(await execute('Math.max(...fixture.peaks) <= 0.043'), true, 'Default output is quiet')
    await delay(1550)
    await execute(`fixture.sounds.notify('idle'); fixture.sounds.notify('yield'); fixture.sounds.notify('yield')`)
    await wait(`fixture.tones.length === 6`)
    assert.deepEqual(await execute('fixture.tones.slice(-2)'), [659.25, 880], 'Yield wins simultaneous notifications')
    await execute(`fixture.sounds.notify('idle')`)
    await delay(180)
    assert.equal(await execute('fixture.tones.length'), 6, 'Burst idle events are quiet')
    await execute(`document.querySelector('.sound-event input').click(); fixture.sounds.notify('yield')`)
    await delay(180)
    assert.equal(await execute('fixture.tones.length'), 6, 'Individual event preference is respected')
    await execute(`fixture.sounds.setPreferences({yield:true}); fixture.sounds.notify('yield'); document.querySelector('.sound-settings > .sound-toggle input').click()`)
    await delay(1550)
    assert.equal(await execute('fixture.tones.length'), 6, 'Muting cancels a pending cue')
    assert.equal(await execute(`document.querySelector('.sound-settings fieldset').disabled`), true)
    await execute(`document.querySelector('.sound-settings > .sound-toggle input').click();
      const volume = document.querySelector('input[type=range]'); volume.value = '0'; volume.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('[aria-label="Preview session idle sound"]').click();`)
    await delay(180)
    assert.equal(await execute('fixture.tones.length'), 6, 'Zero volume is silent')
    await execute(`{
      const volume = document.querySelector('input[type=range]'); volume.value = '50'; volume.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('[aria-label="Preview session idle sound"]').click();
    }`)
    await wait(`fixture.tones.length === 8`)
    assert.equal(await execute(`Math.abs(fixture.peaks.at(-1) - 0.06) < 0.0001`), true)
    await execute(`fixture.contexts[0].close()`)
    await wait(`!fixture.sounds.ready.value`)
    await execute(`document.querySelector('[aria-label="Preview session idle sound"]').click()`)
    await wait(`fixture.tones.length === 10 && fixture.contexts.length === 2`)
    await execute(`document.querySelector('.sound-settings > .sound-toggle input').click()`)
    await window.loadURL(url)
    await wait(`!!document.querySelector('.sound-settings')`)
    assert.equal(await execute('fixture.sounds.preferences.value.enabled'), false)
    assert.equal(await execute('fixture.sounds.preferences.value.volume'), 0.5)
    await execute(`fixture.failAudio = true; document.querySelector('.sound-settings > .sound-toggle input').click()`)
    await wait(`document.querySelector('.sound-settings [role=alert]')?.textContent.includes('Could not enable')`)
    await execute(`fixture.failAudio = false; document.querySelector('[aria-label="Preview session idle sound"]').click()`)
    await wait(`fixture.tones.length === 2 && !document.querySelector('.sound-settings [role=alert]')`)
    await execute(`fixture.app.unmount(); fixture.sounds.notify('yield')`)
    await wait(`fixture.contexts.every(context => context.state === 'closed')`)
    await delay(180)
    assert.equal(await execute('fixture.tones.length'), 2)
    console.log('SOUND_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
