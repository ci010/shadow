import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
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
    const wait = (predicate: string) => run(`new Promise((resolve,reject)=>{const check=()=>{if(${predicate}){clearInterval(timer);clearTimeout(deadline);resolve()}};const timer=setInterval(check,20);const deadline=setTimeout(()=>{clearInterval(timer);reject(new Error('Timed out: '+${JSON.stringify(predicate)}+'; '+document.body.innerText))},10000);check()})`)
    const click = (selector: string) => run(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el || !el.checkVisibility() || el.disabled)throw new Error('Not actionable: '+${JSON.stringify(selector)});el.click();await fixture.tick()})()`)
    const fill = (selector: string, value: string) => run(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));await fixture.tick()})()`)
    const progress = async (step: number) => assert.equal(await run(`document.querySelector('.step-count').textContent`), `Step ${step} of 3`)
    const noCompletion = async () => {
      assert.deepEqual(await run(`({completed:fixture.completed,launches:fixture.launches,ready:!!document.querySelector('.launch-summary')})`),
        { completed: false, launches: [], ready: false }, 'No workspace completion/launch before live provider readiness')
      assert.equal(await run(`fixture.events.some(event=>event.type==='provider-configured')`), false)
    }
    const screenshot = async (name: string) => {
      const directory = process.env.WIZARD_ROLE_SCREENSHOT_DIR
      if (!directory) return
      window.setSize(1100, 900)
      // Hidden Electron windows may suspend animation frames; explicitly finish entrance
      // animations for the optional inspection image, without changing production styles.
      await run(`document.documentElement.classList.remove('dark');document.getAnimations().forEach(animation=>animation.finish());new Promise(r=>setTimeout(r,60))`)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, name), (await window.webContents.capturePage()).toPNG())
    }
    const responsive = async (screen: string) => {
      for (const width of [1100, 400]) {
        window.setSize(width, 900)
        for (const dark of [false, true]) {
          const dimensions = await run(`(async()=>{document.documentElement.classList.toggle('dark',${dark});await new Promise(r=>setTimeout(r,60));return {width:innerWidth,scroll:document.documentElement.scrollWidth}})()`)
          assert.ok(dimensions.scroll <= dimensions.width + 1, `${screen} overflow at ${width}/${dark ? 'dark' : 'light'}: ${JSON.stringify(dimensions)}`)
        }
      }
    }
    const providerForm = async () => {
      await wait(`document.querySelector('.provider-setup')`)
      await click('.method-tabs button:nth-child(2)')
      await wait(`document.querySelector('form.method-panel')`)
    }
    const save = async () => {
      await fill('form.method-panel input[type=password]', 'fixture-not-a-real-key')
      await click('form.method-panel button.primary')
    }
    const savedState = (step: string, localExecutor = false) => JSON.stringify({ version: 1, revision: 4, mode: 'main', step, localExecutor })

    // The initial, public screen is a single recommended action, not a Main/Child question.
    await wait(`window.fixture && document.querySelector('details.advanced-setup')`)
    assert.equal(await run(`document.querySelector('#setup-title').textContent`), 'Welcome to Shadow')
    assert.equal(await run(`document.querySelector('details.advanced-setup').open`), false)
    assert.equal(await run(`document.querySelector('.role-list').checkVisibility()`), false)
    assert.equal(await run(`document.querySelector('.role-option').getAttribute('aria-checked')`), 'true')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), true)
    assert.equal(await run(`document.querySelector('.primary-button').textContent.trim()`), 'Get started')
    await progress(1)
    await responsive('welcome')
    await screenshot('onboarding-welcome.png')
    await click('.primary-button')
    await wait(`document.querySelector('.provider-setup')`)
    await screenshot('onboarding-provider.png')
    assert.equal(await run(`document.querySelector('.provider-setup > .notice.error')`), null, 'An unconfigured first-run connection is not presented as a failure')
    assert.equal(await run(`document.querySelector('.provider-setup > .setup-title').checkVisibility()`), false, 'Use the wizard heading without repeating it')
    await progress(2)
    await noCompletion()
    assert.equal(await run(`document.querySelector('#main-directory')`), null)
    assert.deepEqual(await run(`({events:fixture.events,loads:fixture.directoryLoads,pickers:fixture.pickerCalls,commits:fixture.commits,initializations:fixture.initializations,preparations:fixture.preparations})`), {
      events: [{ type: 'select-role', mode: 'main', localExecutor: true }], loads: 1, pickers: 0,
      commits: ['recommended-folder'], initializations: 1, preparations: [{ localExecutor: true, port: 43123 }],
    })
    assert.deepEqual(await run('fixture.calls'), ['select-role', 'getMainDirectorySelection', 'commitMainDirectory', 'initializeMain', 'prepareProvider', 'GET /api/provider/setup?refresh=true'])
    assert.equal(await run('fixture.state.step'), 'configure-provider')
    // Actual Copilot device-login UI remains in setup while authorization is pending.
    await click('.method-panel .primary')
    await wait(`document.querySelector('.device-code')`)
    assert.match(await run(`document.querySelector('.device-panel').textContent`), /FAKE-CODE/)
    await noCompletion()
    await responsive('provider login')
    await click('.method-panel > .actions button')
    await wait(`!document.querySelector('.device-panel')`)
    await providerForm()
    await responsive('provider key form')
    // A rejected credential save must not emit the wizard transition.
    await run('fixture.saveReady=false')
    await save()
    await wait(`document.querySelector('.provider-setup > .notice.error')?.textContent.includes('Configuration was not saved')`)
    await noCompletion()
    // Even a successful POST is insufficient: the wizard independently rechecks live status.
    await run('fixture.saveReady=true;fixture.liveReadyAfterSave=false')
    await save()
    await wait(`document.querySelector('.action-error')?.textContent.includes('Connect a model service before continuing')`)
    await noCompletion()
    assert.equal(await run('fixture.state.step'), 'configure-provider')
    assert.equal(await run(`fixture.requests.filter(r=>r.path==='/api/provider/setup?refresh=true').length`), 2)
    // Exercise asynchronous saving, the real configured event and a fresh readiness GET.
    await run('fixture.liveReadyAfterSave=true;fixture.holdSave=true')
    await save()
    await wait(`!!fixture.releaseSave && document.querySelector('form.method-panel button.primary').disabled`)
    await noCompletion()
    await run('fixture.releaseSave()')
    await wait(`document.querySelector('.launch-summary') && !document.querySelector('.primary-button').disabled`)
    await progress(3)
    assert.match(await run(`document.querySelector('.launch-summary').textContent`), /Model serviceOpenAI/)
    assert.equal(await run(`document.querySelector('.primary-button').textContent.trim()`), 'Start chatting')
    assert.equal(await run('fixture.completed'), false)
    assert.deepEqual(await run('fixture.events'), [{ type: 'select-role', mode: 'main', localExecutor: true }, { type: 'provider-configured' }])
    assert.deepEqual(await run('fixture.calls.slice(-3)'), ['POST /api/provider/setup', 'GET /api/provider/setup?refresh=true', 'provider-configured'])
    assert.deepEqual(await run(`fixture.requests.filter(r=>r.method==='POST' && r.path==='/api/provider/setup').at(-1).body`),
      { provider: 'openai', model: 'gpt-4.1', apiKey: 'fixture-not-a-real-key', baseUrl: '' })
    assert.equal(await run(`JSON.stringify({...localStorage}).includes('fixture-not-a-real-key')`), false)
    await responsive('ready summary')
    await run('fixture.failLaunch=true')
    await click('.primary-button')
    await wait(`document.querySelector('.action-error')`)
    assert.equal(await run('fixture.completed'), false)
    await run('fixture.failLaunch=false')
    await click('.primary-button')
    await wait('fixture.completed')
    assert.deepEqual(await run('fixture.launches'), [{ localExecutor: true, port: 43123 }, { localExecutor: true, port: 43123 }])

    // Advanced choices remain optional, and changing roles keeps the unsaved executor choice.
    await run('fixture.reset()')
    await click('details.advanced-setup > summary')
    await click('[role=switch]')
    await click('.role-option:nth-child(2)')
    assert.equal(await run(`document.querySelector('[role=switch]')`), null)
    await click('.role-option')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), false)
    await click('[aria-label="Choose a different data folder"]')
    await responsive('advanced options')
    await click('.primary-button')
    await wait(`document.querySelector('#main-directory') && !document.querySelector('.primary-button').disabled`)
    await progress(1)
    assert.equal(await run('fixture.initializations'), 0)
    assert.equal(await run('fixture.preparations.length'), 0)
    assert.equal(await run('fixture.pickerCalls'), 0)
    // Saved wizard preference wins over a stale browser value after restart.
    await run(`localStorage.setItem('shadow.bootstrap.local-executor','true');fixture.mount()`)
    await wait(`document.querySelector('#main-directory') && !document.querySelector('.primary-button').disabled`)
    await fill('#main-directory', 'C:/fixture-only/custom')
    await responsive('custom directory')
    await click('.primary-button')
    await wait(`document.querySelector('.provider-setup')`)
    assert.deepEqual(await run('fixture.commits'), ['custom-folder'])
    assert.deepEqual(await run('fixture.paths'), ['C:/fixture-only/custom'])
    assert.deepEqual(await run('fixture.preparations'), [{ localExecutor: false, port: 43123 }])
    assert.equal(await run('fixture.state.localExecutor'), false)
    await providerForm()
    await save()
    await wait(`document.querySelector('.launch-summary') && !document.querySelector('.primary-button').disabled`)
    await click('.primary-button')
    await wait('fixture.completed')
    assert.deepEqual(await run('fixture.launches'), [{ localExecutor: false, port: 43123 }])

    // Initialization failure persists its checkpoint; retry does not select or commit again.
    await run('fixture.reset({failInitialize:true})')
    await click('.primary-button')
    await wait(`document.querySelector('.action-error')`)
    assert.equal(await run('fixture.state.step'), 'initialize-main')
    await noCompletion()
    assert.equal(await run('fixture.preparations.length'), 0)
    await run('fixture.failInitialize=false')
    await click('.primary-button')
    await wait(`document.querySelector('.provider-setup')`)
    assert.equal(await run('fixture.initializations'), 2)
    assert.equal(await run('fixture.commits.length'), 1)
    assert.equal(await run('fixture.directoryLoads'), 1)

    // Initialization can persist successfully while its IPC response is lost. Retry reloads
    // the checkpoint instead of reinitializing an already-created installation.
    await run('fixture.reset({loseInitializeReply:true})')
    await click('.primary-button')
    await wait(`document.querySelector('.action-error')`)
    assert.equal(await run('fixture.state.step'), 'configure-provider')
    await noCompletion()
    await click('.primary-button')
    await wait(`document.querySelector('.provider-setup')`)
    assert.equal(await run('fixture.initializations'), 1)
    assert.equal(await run('fixture.commits.length'), 1)
    assert.equal(await run('fixture.preparations.length'), 1)

    // Restart at initialization auto-continues, without displaying the welcome/directory screen.
    await run(`fixture.reset({state:${savedState('initialize-main')}})`)
    await wait(`document.querySelector('.provider-setup')`)
    assert.equal(await run('fixture.initializations'), 1)
    assert.equal(await run('fixture.directoryLoads'), 0)
    assert.deepEqual(await run('fixture.events'), [])
    // A prepare failure resumes the saved configure checkpoint with no repeated initialization.
    await run('fixture.reset({failPrepare:true})')
    await click('.primary-button')
    await wait(`document.querySelector('.action-error')`)
    assert.equal(await run('fixture.state.step'), 'configure-provider')
    await noCompletion()
    await run('fixture.failPrepare=false;fixture.mount()')
    await wait(`document.querySelector('.provider-setup')`)
    assert.equal(await run('fixture.initializations'), 1)
    assert.equal(await run('fixture.commits.length'), 1)
    assert.equal(await run('fixture.preparations.length'), 2)
    // Live status HTTP errors also remain recoverable and never expose Start chatting.
    await run(`fixture.reset({state:${savedState('configure-provider')},failStatus:true})`)
    await wait(`document.querySelector('.action-error')`)
    await noCompletion()
    await run('fixture.failStatus=false')
    await click('.primary-button')
    await wait(`document.querySelector('.provider-setup')`)
    assert.equal(await run('fixture.initializations'), 0)

    // Old Desktop has no safe provider bridge: explicit upgrade, not a placeholder Continue.
    await run(`fixture.reset({state:${savedState('configure-provider')},oldDesktop:true})`)
    await wait(`document.querySelector('.action-error')`)
    assert.match(await run(`document.querySelector('.action-error').textContent`), /Update and restart Desktop/)
    await noCompletion()
    assert.deepEqual(await run('fixture.requests'), [])

    // Legacy launch records (including the removed step) still require real credentials.
    for (const step of ['launch-main', 'choose-local-capabilities']) {
      await run(`localStorage.setItem('shadow.bootstrap.local-executor','false');fixture.reset({state:{version:1,revision:4,mode:'main',step:${JSON.stringify(step)}}})`)
      await wait(`document.querySelector('.provider-setup')`)
      await progress(2)
      await noCompletion()
      assert.equal(await run('fixture.state.step'), 'launch-main')
      assert.equal(await run('fixture.initializations'), 0)
      assert.equal(await run('fixture.directoryLoads'), 0)
      assert.deepEqual(await run('fixture.preparations'), [{ localExecutor: false, port: 43123 }])
      await providerForm()
      await save()
      await wait(`document.querySelector('.launch-summary') && !document.querySelector('.primary-button').disabled`)
      await progress(3)
      // Already-persisted launch checkpoint must not dispatch provider-configured a second time.
      assert.deepEqual(await run('fixture.events'), [])
      await click('.primary-button')
      await wait('fixture.completed')
    }
    // Already-ready live status skips credential entry, but never starts chatting automatically.
    for (const step of ['configure-provider', 'launch-main']) {
      await run(`fixture.reset({state:${savedState(step)},status:fixture.ready()})`)
      await wait(`document.querySelector('.launch-summary') && !document.querySelector('.primary-button').disabled`)
      await progress(3)
      assert.equal(await run(`document.querySelector('.provider-setup')`), null)
      assert.equal(await run('fixture.completed'), false)
      assert.deepEqual(await run('fixture.launches'), [])
      assert.deepEqual(await run('fixture.events'), step === 'configure-provider' ? [{ type: 'provider-configured' }] : [])
    }
    // Fresh install ignores legacy browser choice; translated advanced labels still work.
    await run('fixture.reset()')
    await click('details.advanced-setup > summary')
    assert.equal(await run(`document.querySelector('[role=switch]').checked`), true)
    await run(`fixture.locale('zh-CN');fixture.tick()`)
    assert.equal(await run(`document.querySelector('[role=switch]').getAttribute('aria-label')`), '同时在此电脑执行任务')
    assert.match(await run(`document.getElementById('local-executor-help').textContent`), /关闭后，执行任务需要连接 Child 设备/)
    await responsive('translated advanced options')
    await run(`fixture.locale('en');fixture.tick()`)
    // Child entry is still available in advanced settings and sends no Main-only preferences.
    await click('.role-option:nth-child(2)')
    await click('.primary-button')
    await wait(`document.querySelector('.child-form')`)
    assert.deepEqual(await run('fixture.events'), [{ type: 'select-role', mode: 'child' }])
    assert.equal(await run('fixture.directoryLoads'), 0)
    assert.equal(await run('fixture.preparations.length'), 0)
    assert.equal(await run(`document.querySelector('.step-count')`), null)
    await responsive('child pairing')
    console.log('WIZARD_ROLE_SMOKE_OK')
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
