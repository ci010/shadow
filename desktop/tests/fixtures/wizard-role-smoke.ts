import assert from 'node:assert/strict'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const base = process.env.WIZARD_ROLE_SMOKE_URL!
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(base) }))
  const window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await window.loadURL(`${base}__wizard-role`)
    const run = (script: string) => window.webContents.executeJavaScript(script)
    const wait = (predicate: string) => run(`new Promise((resolve,reject)=>{const check=()=>{if(${predicate}){clearInterval(timer);clearTimeout(deadline);resolve()}};const timer=setInterval(check,20);const deadline=setTimeout(()=>{clearInterval(timer);reject(new Error('Timed out: '+${JSON.stringify(predicate)}))},10000);check()})`)
    const click = (selector: string) => run(`(async()=>{document.querySelector(${JSON.stringify(selector)}).click();await fixture.tick()})()`)
    await wait(`window.fixture && document.querySelector('.role-option')`)
    assert.equal(await run(`document.querySelector('[role=switch]')`), null)
    await click('.role-option')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), true, 'Main defaults to local execution')
    for (const width of [1100, 400]) {
      window.setSize(width, 900)
      for (const dark of [false, true]) {
        await run(`document.documentElement.classList.toggle('dark',${dark})`)
        await wait(`document.documentElement.scrollWidth <= innerWidth + 1`)
      }
    }
    await click('[role=switch]')
    await click('.role-option:nth-child(2)')
    assert.equal(await run(`document.querySelector('[role=switch]')`), null, 'Child has no redundant executor choice')
    await click('.role-option')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), false, 'Switching roles retains unsaved Main choice')
    await click('.primary-button')
    await wait(`document.querySelector('#main-directory') && !document.querySelector('.primary-button').disabled`)
    assert.deepEqual(await run('fixture.events'), [{ type: 'select-role', mode: 'main', localExecutor: false }])
    // Durable wizard state wins over stale browser preference on restart.
    await run(`localStorage.setItem('shadow.bootstrap.local-executor','true');fixture.mount()`)
    await wait(`document.querySelector('#main-directory') && !document.querySelector('.primary-button').disabled`)
    assert.match(await run(`document.querySelector('.step-count').textContent`), /Step 1 of 4/)
    await click('.primary-button')
    await wait(`fixture.state.step === 'initialize-main' && !document.querySelector('.primary-button').disabled`)
    await click('.primary-button')
    await wait(`fixture.state.step === 'configure-provider' && !document.querySelector('.primary-button').disabled`)
    await click('.primary-button')
    await wait(`fixture.state.step === 'launch-main' && !document.querySelector('.primary-button').disabled`)
    assert.match(await run(`document.querySelector('.step-count').textContent`), /Step 4 of 4/)
    assert.match(await run(`document.querySelector('.launch-summary').textContent`), /Also run tasks on this computerDisabled/)
    assert.equal(await run(`document.querySelector('[role=switch]')`), null)
    await click('.primary-button')
    await wait(`document.querySelector('.action-error')`)
    await run('fixture.failLaunch=false')
    await click('.primary-button')
    await wait('fixture.completed')
    assert.deepEqual(await run('fixture.launches'), [{ localExecutor: false, port: 43123 }, { localExecutor: false, port: 43123 }])
    // New Child role requests never contain a Main execution preference.
    await run('fixture.reset()')
    await click('.role-option:nth-child(2)')
    await click('.primary-button')
    await wait(`document.querySelector('.child-form')`)
    assert.deepEqual(await run('fixture.events'), [{ type: 'select-role', mode: 'child' }])
    // Existing setups resume past the removed step and retain their old localStorage choice.
    await run(`localStorage.setItem('shadow.bootstrap.local-executor','false');fixture.mount({version:1,revision:4,mode:'main',step:'choose-local-capabilities'})`)
    assert.match(await run(`document.querySelector('.launch-summary').textContent`), /Also run tasks on this computerDisabled/)
    await run('fixture.reset()')
    await click('.role-option')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), true, 'A fresh setup defaults on, independent of legacy localStorage')
    await run(`fixture.locale('zh-CN');fixture.tick()`)
    assert.equal(await run(`document.querySelector('[role=switch]').getAttribute('aria-label')`), '同时在此电脑执行任务')
    assert.match(await run(`document.getElementById('local-executor-help').textContent`), /关闭后，执行任务需要连接 Child 设备/)
    console.log('WIZARD_ROLE_SMOKE_OK')
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
