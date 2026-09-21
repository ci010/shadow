import assert from 'node:assert/strict'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { installChildBackgroundWindow } from '../../src/child-background.js'

app.setPath('userData', join(process.cwd(), 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const base = process.env.CHILD_SMOKE_URL!
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(base) }))
  const window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await window.loadURL(`${base}__child`)
    const run = (script: string) => window.webContents.executeJavaScript(script)
    await run(`new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.fixture&&document.querySelector('.role-option')){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(new Error('Wizard did not mount'))},10000)})`)
    await run(`(async()=>{const sleep=()=>new Promise(r=>setTimeout(r,50));document.querySelectorAll('.role-option')[1].click();await sleep();document.querySelector('.primary-button').click();await sleep()})()`)
    assert.equal(await run(`document.querySelector('.child-form button[type=submit]').disabled`), true)
    assert.equal(await run(`document.getElementById('child-offer') === null && document.getElementById('child-pin') === null`), true)
    const invitation = 'shadow-child:v1:' + btoa(JSON.stringify({
      version: 1, endpoint: 'http://192.168.1.5:43125', offerId: 'offer-1', pin: '000012',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }))
    const paste = (value: string) => run(`(async()=>{
      const el=document.getElementById('child-invitation');el.value=${JSON.stringify(value)};
      el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,30));
    })()`)
    await paste(invitation)
    assert.match(await run(`document.getElementById('child-invitation-help').textContent`), /192\.168\.1\.5:43125/)
    for (const width of [1100, 400]) {
      window.setSize(width, 900)
      for (const theme of ['light', 'dark']) {
        assert.equal(await run(`(async()=>{document.documentElement.classList.toggle('dark',${theme === 'dark'});await new Promise(r=>setTimeout(r,60));return document.documentElement.scrollWidth<=innerWidth+1})()`), true, `Wizard overflow at ${width}/${theme}`)
      }
    }
    await paste('not-an-invitation')
    await run(`(async()=>{document.querySelectorAll('.consent-row input')[1].click();
      await new Promise(r=>setTimeout(r,30));document.querySelector('.child-form').requestSubmit();await new Promise(r=>setTimeout(r,100))})()`)
    assert.equal(await run('fixture.pairs.length'), 0, 'Invalid invitation must not reach IPC')
    assert.match(await run(`document.querySelector('.action-error').textContent`), /Invalid Child invitation/)
    await paste(invitation)
    await run(`document.querySelector('.child-form').requestSubmit();new Promise(r=>setTimeout(r,100))`)
    const failed = await run(`({pairs:fixture.pairs,invitation:document.getElementById('child-invitation').value,error:document.querySelector('.action-error')?.textContent})`)
    assert.equal(failed.pairs.length, 1)
    assert.equal(failed.pairs[0].executionConsent, true)
    assert.equal(Object.hasOwn(failed.pairs[0], 'saved'), false)
    assert.equal(failed.pairs[0].pin, '000012')
    assert.equal(failed.pairs[0].offerId, 'offer-1')
    assert.equal(failed.pairs[0].endpoint, 'http://192.168.1.5:43125')
    assert.equal(Object.hasOwn(failed.pairs[0], 'expiresAt'), false)
    assert.equal(failed.invitation, '')
    assert.match(failed.error, /Pairing failed/)
    await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Enter details manually').click();new Promise(r=>setTimeout(r,30))`)
    assert.equal(await run(`!!document.getElementById('child-offer') && document.getElementById('child-invitation') === null`), true)
    await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Paste invitation instead').click();new Promise(r=>setTimeout(r,30))`)
    await paste(invitation)
    await run(`fixture.fail=false;document.querySelector('.child-form').requestSubmit();new Promise(r=>setTimeout(r,100))`)
    assert.equal(await run('fixture.completed'), true)
    await run(`fixture.openChild();new Promise(r=>setTimeout(r,100))`)
    const offline = await run(`document.body.innerText`)
    assert.match(offline, /Not connected to Main/)
    assert.match(offline, /sha256:1234567890abcdef/)
    assert.ok(!offline.includes('Connected to Main'))
    assert.match(offline, /not proxied/)
    for (const width of [1100, 400]) {
      window.setSize(width, 900)
      assert.equal(await run(`new Promise(r=>setTimeout(()=>r(document.documentElement.scrollWidth<=innerWidth+1),60))`), true, `Child shell overflow at ${width}`)
    }
    await run(`fixture.connection='connected';document.querySelector('.child-status button').click();new Promise(r=>setTimeout(r,100))`)
    assert.match(await run('document.body.innerText'), /Connected to Main/)
    const disposeBackground = installChildBackgroundWindow(app, window, () => true)
    window.show()
    window.close()
    assert.equal(window.isDestroyed(), false, 'Closing Child must not destroy its window or quit the owner')
    assert.equal(window.isVisible(), false)
    assert.match(await run('document.body.innerText'), /Connected to Main/)
    app.emit('activate', {} as Electron.Event, false)
    assert.equal(window.isVisible(), true, 'Dock activation must reopen the same Child window')
    window.hide()
    disposeBackground()
    await run(`fixture.statusFailure=true;document.querySelector('.child-status button').click();new Promise(r=>setTimeout(r,100))`)
    const failedStatus = await run('document.body.innerText')
    assert.match(failedStatus, /Main connection is unknown/)
    assert.ok(!failedStatus.includes('Connected to Main'))
    assert.equal(await run(`fixture.requests.every(url=>url.endsWith('/local/v1/child')||url.endsWith('/local/v1/nodes'))`), true)
    console.log('CHILD_SMOKE_OK')
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
