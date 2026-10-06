import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  await window.webContents.session.setProxy({ mode: 'direct' })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(40) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const type = async (text: string) => {
    await execute(`{const input=document.querySelector('.composer-input textarea');input.focus();input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));}`)
    await delay(20)
  }
  const key = (extra = '') => execute(`(() => {const input=document.querySelector('.composer-input textarea');const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,${extra}});input.dispatchEvent(event);return event.defaultPrevented;})()`)
  const screenshot = async (name: string) => {
    if (!process.env.COMPOSER_SCREENSHOTS) return
    await delay(60)
    await writeFile(join(process.env.COMPOSER_SCREENSHOTS, name + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(new URL('__composer', process.env.COMPOSER_SMOKE_URL).href)
    await wait(`window.__composerFixture?.state().activeSessionId === 'web:chat-composer-fixture' && window.__composerFixture.state().mounted && !window.__composerFixture.state().loadingHistory && !!document.querySelector('.composer-input textarea')`)
    await execute(`window.__composerFixture.state().currentWorkdir={kind:'local',displayPath:'C:\\\\fixture',available:true}`)
    await type('Queue this exact text')
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',ctrlKey:true,bubbles:true}))`)
    await wait(`!!document.querySelector('button[aria-label="Add to queue"] .i-lucide-list-plus')`)
    assert.match(await execute(`document.querySelector('.composer-hint').textContent`), /Ctrl\+Enter.*queue/)
    await key('ctrlKey:true')
    await wait(`window.__composerFixture.sent.length === 1`)
    assert.equal(await execute(`window.__composerFixture.sent[0].delivery`), 'queue')
    await execute(`document.dispatchEvent(new KeyboardEvent('keyup',{key:'Control',bubbles:true}));window.__composerFixture.reset()`)
    await type('Click to queue')
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',ctrlKey:true,bubbles:true}))`)
    await wait(`!!document.querySelector('button[aria-label="Add to queue"]')`)
    await execute(`document.querySelector('button[aria-label="Add to queue"]').click()`)
    await wait(`window.__composerFixture.sent.length === 2`)
    assert.equal(await execute(`window.__composerFixture.sent[1].delivery`), 'queue')
    await execute(`window.dispatchEvent(new Event('blur'));window.__composerFixture.reset()`)
    await type('Ordinary send')
    assert.equal(await key('shiftKey:true'), false)
    assert.equal(await key('isComposing:true'), false)
    assert.equal(await key('repeat:true'), false)
    assert.equal(await execute(`window.__composerFixture.sent.length`), 2)
    await key()
    await wait(`window.__composerFixture.sent.length === 3`)
    assert.equal(await execute(`window.__composerFixture.sent[2].delivery`), undefined)
    await execute(`window.__composerFixture.ask()`)
    await wait(`!!document.querySelector('.yield-composer-note') && !!document.querySelector('.composer-reply-context')`)
    assert.equal(await execute(`document.querySelectorAll('textarea').length`), 1)
    assert.match(await execute(`document.querySelector('.yield-composer-note').textContent`), /below.*images and files/)
    await execute(`document.querySelector('.yield-custom-toggle').click()`)
    await wait(`document.activeElement === document.querySelector('.composer-input textarea')`)
    await type('/my literal custom answer')
    await execute(`{const input=document.querySelector('.composer-file-input');const files=new DataTransfer();files.items.add(new File(['Fixture attachment'],'notes.txt'));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));window.__composerFixture.reject=true;}`)
    await wait(`!!document.querySelector('.attachment-chip')`)
    const sentBefore = await execute(`window.__composerFixture.sent.length`)
    await key()
    await wait(`document.querySelector('.yield-error')?.textContent.includes('Synthetic answer conflict')`)
    assert.equal(await execute(`document.querySelector('.composer-input textarea').value`), '/my literal custom answer')
    assert.equal(await execute(`document.querySelectorAll('.attachment-chip').length`), 1)
    assert.equal(await execute(`window.__composerFixture.sent.length`), sentBefore)
    await execute(`window.__composerFixture.reject=false`)
    await key()
    await wait(`window.__composerFixture.answers.length === 2 && !document.querySelector('.yield-question')`)
    assert.deepEqual(await execute(`window.__composerFixture.answers.at(-1).media`), ['C:\\fixture\\uploads\\notes.txt'])
    assert.equal(await execute(`document.querySelector('.composer-input textarea').value`), '')
    await execute(`window.__composerFixture.ask('input')`)
    await wait(`!!document.querySelector('.yield-composer-note')`)
    await screenshot('composer-desktop')
    window.setContentSize(390, 844)
    await delay(100)
    await wait(`document.querySelector('.chat-workspace').classList.contains('mobile-chat')`)
    assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)
    assert.equal(await execute(`document.querySelectorAll('textarea').length`), 1)
    assert.equal(await execute(`document.querySelector('.composer-input textarea').getBoundingClientRect().right <= document.querySelector('.composer-stop').getBoundingClientRect().left`), true, 'Text input must not overlap the stop and send buttons')
    await screenshot('composer-mobile')
    await type('My narrow-screen answer')
    assert.equal(await key(), false, 'Mobile keeps native newline input')
    await execute(`document.querySelector('button[aria-label="Send answer"]').click()`)
    await wait(`window.__composerFixture.answers.at(-1)?.text === 'My narrow-screen answer'`)
    await execute(`window.__composerFixture.ask('input');window.__composerFixture.showDedicated()`)
    await wait(`!!document.querySelector('.yield-custom textarea')`)
    await execute(`{const input=document.querySelector('.yield-custom textarea');input.value='Enter submits the dedicated answer';input.dispatchEvent(new Event('input',{bubbles:true}));}`)
    await delay(20)
    await execute(`document.querySelector('.yield-custom textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    await wait(`window.__composerFixture.answers.at(-1)?.text === 'Enter submits the dedicated answer'`)
    console.log('COMPOSER_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
