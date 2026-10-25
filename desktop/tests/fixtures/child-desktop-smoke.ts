import assert from 'node:assert/strict'
import { join } from 'node:path'
import { app, BrowserWindow, session, utilityProcess } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createUtilityProcessSpawn } from '../../src/sidecar/utility-process.js'
import { installBackgroundWindow } from '../../src/background-window.js'

app.setPath('userData', join(process.cwd(), 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  // Exercise the real Electron API: undefined Child-only env entries used to
  // synchronously throw "Invalid value for env", before any backend was run.
  const utilityEntry = join(process.cwd(), 'utility-child.cjs')
  await writeFile(utilityEntry, 'process.exit(0)')
  const spawnUtility = createUtilityProcessSpawn((entry, args, options) => utilityProcess.fork(entry, args, options))
  const utility = spawnUtility('unused', [utilityEntry], { env: { ...process.env, SHADOW_DESKTOP_MEDIA_KEY: undefined } })
  const [utilityExit] = await once(utility, 'exit')
  assert.equal(utilityExit, 0, 'Child utility must start with an absent Main media key')
  const base = process.env.CHILD_SMOKE_URL!
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(base) }))
  const window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await window.loadURL(`${base}__child`)
    const run = (script: string) => window.webContents.executeJavaScript(script)
    await run(`new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.fixture&&document.querySelector('.role-option')){clearInterval(timer);resolve()}},20);setTimeout(()=>{clearInterval(timer);reject(new Error('Wizard did not mount'))},10000)})`)
    assert.equal(await run(`document.querySelector('details.advanced-setup').open`), false)
    await run(`(async()=>{const sleep=()=>new Promise(r=>setTimeout(r,50));document.querySelector('details.advanced-setup > summary').click();await sleep();document.querySelectorAll('.role-option')[1].click();await sleep();document.querySelector('.primary-button').click();await sleep()})()`)
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
    await run(`document.querySelectorAll('.consent-row input')[0].click();new Promise(r=>setTimeout(r,30))`)
    assert.match(await run('document.body.innerText'), /Explicitly allow trusted LAN\/VPN HTTP/)
    assert.equal(await run('fixture.pairs.length'), 0)
    await run(`document.querySelectorAll('.consent-row input')[0].click();new Promise(r=>setTimeout(r,30))`)
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
    assert.match(offline, /Main workspace unavailable/)
    assert.match(offline, /main_workspace_econnrefused/)
    assert.ok(!offline.includes('This Child'))
    assert.equal(await run(`document.querySelector('.child-status') === null && document.querySelector('.child-shell') === null`), true)
    assert.match(await run(`document.querySelector('.workspace-recovery .desktop-role-settings button').textContent`), /Switch to Main/)
    assert.equal(await run(`document.querySelectorAll('.desktop-title-bar').length`), 1)
    assert.equal(await run('fixture.switches.length'), 0, 'Connection failure must never switch roles automatically')
    for (const width of [1100, 400]) {
      window.setSize(width, 900)
      for (const theme of ['light', 'dark']) {
        assert.equal(await run(`(async()=>{document.documentElement.classList.toggle('dark',${theme === 'dark'});await new Promise(r=>setTimeout(r,60));return document.documentElement.scrollWidth<=innerWidth+1})()`), true, `Workspace recovery overflow at ${width}/${theme}`)
        if (process.env.CHILD_RECOVERY_SCREENSHOTS) {
          await mkdir(process.env.CHILD_RECOVERY_SCREENSHOTS, { recursive: true })
          await writeFile(join(process.env.CHILD_RECOVERY_SCREENSHOTS, `child-recovery-${width}-${theme}.png`), (await window.webContents.capturePage()).toPNG())
        }
      }
    }
    await run(`fixture.holdWorkspace=true;document.querySelector('.workspace-retry').click();new Promise(r=>setTimeout(r,50))`)
    assert.equal(await run(`document.querySelector('.workspace-retry').disabled`), true)
    assert.equal(await run(`document.querySelector('.workspace-recovery .desktop-role-settings button').disabled`), false, 'Role switching must not wait for Main')
    await run(`document.querySelector('.workspace-recovery .desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.match(await run(`document.querySelector('.desktop-role-settings').textContent`), /First-time setup opens automatically/)
    assert.equal(await run('fixture.switches.length'), 0, 'Switching requires explicit confirmation')
    await run(`document.querySelectorAll('.desktop-role-settings button')[1].click();new Promise(r=>setTimeout(r,30))`)
    assert.match(await run(`document.querySelector('.desktop-role-settings button').textContent`), /Switch to Main/)
    await run(`document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    await run(`fixture.completeWorkspaceCheck(Response.json({projects:[]}));new Promise(r=>setTimeout(r,50))`)
    assert.match(await run(`document.querySelector('.workspace-recovery [role=status]').textContent`), /Connected to Main/)
    assert.ok(await run(`!!document.querySelector('.desktop-role-settings')`), 'Reconnection must not remove an active role confirmation')
    await run(`fixture.switchFails=true;document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.deepEqual(await run('fixture.switches'), [{ role: 'main', executionConsent: false }])
    assert.match(await run(`document.querySelector('.desktop-role-settings [role=alert]').textContent`), /saved profiles are retained/)
    await run(`fixture.switches=[];fixture.switchFails=false;fixture.holdWorkspace=false`)
    const disposeBackground = installBackgroundWindow(app, window)
    window.show(); window.close()
    assert.equal(window.isDestroyed(), false)
    assert.equal(window.isVisible(), false)
    app.emit('activate', {} as Electron.Event, false)
    assert.equal(window.isVisible(), true)
    window.hide(); disposeBackground()
    assert.equal(await run(`fixture.requests.every(url=>url.endsWith('/api/projects'))`), true)
    await run(`fixture.openRoleSettings('main');new Promise(r=>setTimeout(r,80))`)
    assert.equal(await run('fixture.switches.length'), 0, 'Merely opening settings never switches the runtime')
    await run(`document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.match(await run('document.body.innerText'), /execute commands as my OS account/)
    assert.equal(await run(`document.querySelector('.desktop-role-settings button').disabled`), true)
    await run(`document.querySelector('.desktop-role-settings input').click();new Promise(r=>setTimeout(r,30))`)
    assert.equal(await run(`document.querySelector('.desktop-role-settings button').disabled`), false)
    await run(`document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.deepEqual(await run('fixture.switches'), [{ role: 'child', executionConsent: true }])
    await run(`fixture.openRoleSettings('child');new Promise(r=>setTimeout(r,50))`)
    await run(`document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.equal(await run(`document.querySelector('.desktop-role-settings input') === null`), true)
    await run(`fixture.switchFails=true;document.querySelector('.desktop-role-settings button').click();new Promise(r=>setTimeout(r,30))`)
    assert.match(await run('document.body.innerText'), /Close and reopen Shadow/)
    assert.deepEqual(await run('fixture.switches[1]'), { role: 'main', executionConsent: false })
    await run(`fixture.openRecovery();new Promise(r=>setTimeout(r,80))`)
    for (const width of [1100, 400]) {
      window.setSize(width, 900)
      await run(`new Promise(r=>setTimeout(r,60))`)
      const recoveryLayout = await run(`(() => { const role=document.querySelector('.desktop-role-settings'); const panel=document.querySelector('.recovery-panel'); return {width:role.getBoundingClientRect().width,panelWidth:panel.getBoundingClientRect().width,column:getComputedStyle(role).gridColumn}; })()`)
      assert.ok(recoveryLayout.width >= recoveryLayout.panelWidth - 65, `Recovery role card must span the brand and text columns at ${width}: ${JSON.stringify(recoveryLayout)}`)
      assert.equal(recoveryLayout.column, '1 / -1')
    }
    console.log('CHILD_SMOKE_OK')
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
