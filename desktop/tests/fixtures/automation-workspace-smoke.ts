import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1280, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  const pendingRequests = new Map<number, string>()
  window.webContents.on('console-message', details => { if (details.level === 'warning' || details.level === 'error') errors.push(details.message) })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => { pendingRequests.set(details.id, details.url); callback({}) })
  window.webContents.session.webRequest.onCompleted(details => { pendingRequests.delete(details.id); if (details.statusCode >= 400) errors.push(`${details.statusCode}: ${details.url}`) })
  window.webContents.session.webRequest.onErrorOccurred(details => { pendingRequests.delete(details.id); errors.push(`${details.error}: ${details.url}`) })
  const execute = async (code: string) => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (cause) { throw new Error(`Renderer script failed: ${code}`, { cause }) }
  }
  const wait = async (code: string) => {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}\nPending: ${[...pendingRequests.values()].join('\n')}\n${await execute(`JSON.stringify({ready:document.readyState,router:!!window.__automationRouter,html:document.body.innerHTML.slice(0,1000),resources:performance.getEntriesByType('resource').slice(-10).map(item=>item.name)})`)}`)
  }
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const geometry = () => execute(`(() => {
    const r = document.querySelector('.automation-editor').getBoundingClientRect();
    const toolbar = document.querySelector('.automation-toolbar').getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height,toolbar:toolbar.height};
  })()`)
  const screenshot = async (name: string) => {
    await frame()
    if (process.env.AUTOMATION_SCREENSHOTS) await writeFile(join(process.env.AUTOMATION_SCREENSHOTS, name + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(new URL('__automations', process.env.AUTOMATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('[aria-label="Loading runs"]') && !!document.querySelector('.automation-empty')`)
    assert.equal(await execute(`document.querySelector('.automation-info').open`), false)
    assert.equal(await execute(`document.querySelectorAll('.automation-tabs [role="tab"]').length`), 0)
    const initial = await geometry()
    await screenshot('automation-loading-desktop')
    await execute(`fetch('/__fixture/release')`)
    await wait(`document.querySelectorAll('.automation-run').length === 30 && !document.querySelector('[aria-label="Loading runs"]')`)
    assert.deepEqual(await geometry(), initial, 'Loading the catalog and run page must not move the editor')
    assert.equal(await execute(`document.querySelector('.runs-scroll').scrollHeight > document.querySelector('.runs-scroll').clientHeight`), true)
    await execute(`window.__firstRunRow = document.querySelector('.automation-run'); document.querySelector('.runs-scroll').scrollTop = 100000`)
    await wait(`document.querySelectorAll('.automation-run').length === 60`)
    assert.equal(await execute(`window.__firstRunRow === document.querySelector('.automation-run')`), true)
    assert.deepEqual(await geometry(), initial)
    await execute(`document.querySelector('[data-session-id="cron:run-0"]').click()`)
    await wait(`!!document.querySelector('.conversation-skeleton') && document.querySelectorAll('.run-tab').length === 1`)
    assert.equal(await execute(`document.querySelector('.learning-outcome').innerText.includes('Partial')`), true)
    assert.equal(await execute(`document.querySelector('.learning-outcome').innerText.includes('Execution: Completed')`), true)
    const conversation = await geometry()
    assert.deepEqual(conversation, initial, 'Opening a run uses the same content rectangle instead of inserting navigation')
    assert.equal(await execute(`document.querySelector('.explorer-toggle')?.getAttribute('aria-expanded') ?? 'false'`), 'false')
    await screenshot('automation-run-loading-desktop')
    await execute(`fetch('/__fixture/history')`)
    await wait(`document.querySelector('.automation-conversation').innerText.includes('Synthetic run result') && !document.querySelector('.conversation-skeleton')`)
    await wait(`!!document.querySelector('.explorer-toggle')`)
    assert.deepEqual(await geometry(), conversation)
    assert.equal(await execute(`document.querySelector('.explorer-toggle').getAttribute('aria-expanded')`), 'false')
    assert.equal(await execute(`document.querySelectorAll('.conversation-tab').length`), 0, 'The outer run tab replaces the redundant Conversation tab')
    assert.equal(await execute(`document.querySelector('.document-toolbar').closest('.automation-toolbar') !== null`), true, 'Document tabs share the outer toolbar')
    assert.equal(await execute(`document.querySelectorAll('.workbench-editor > .document-toolbar').length`), 0)
    assert.equal(await execute(`!!document.querySelector('.changes-tab, .session-file-changes')`), false)
    assert.equal(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.changes)`), 0)
    await execute(`document.querySelector('[data-session-id="cron:run-1"]').click()`)
    await wait(`document.querySelectorAll('.run-tab').length === 2`)
    assert.equal(await execute(`document.querySelector('.learning-outcome').innerText.includes('No verified learning receipt')`), true)
    const selectedRun = await execute(`window.__automationRouter.currentRoute.value.params.sessionId`)
    await execute(`document.querySelector('.automation-info summary').click()`)
    await wait(`document.querySelector('.automation-info').open`)
    assert.equal(await execute(`document.querySelector('.automation-info').innerText.includes('Review recent work')`), true)
    assert.equal(await execute(`window.__automationRouter.currentRoute.value.params.sessionId`), selectedRun)
    assert.deepEqual(await geometry(), initial, 'Automation details stay in the explorer, not the editor')
    assert.equal(await execute(`document.querySelectorAll('.run-tab').length`), 2)
    await screenshot('automation-details-desktop')
    await execute(`document.querySelector('.automation-info summary').click()`)
    await execute(`document.querySelector('.run-tab [role="tab"]').click()`)
    await wait(`document.querySelector('.run-tab [role="tab"]').getAttribute('aria-selected') === 'true'`)
    await screenshot('automation-runs-desktop')
    await execute(`fetch('/__fixture/hold').then(() => document.querySelector('[aria-label="Refresh runs"]').click())`)
    await wait(`document.querySelector('.runs-scroll').getAttribute('aria-busy') === 'true'`)
    assert.equal(await execute(`document.querySelectorAll('.automation-run').length`), 60)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Loading runs"]')`), false)
    assert.deepEqual(await geometry(), initial)
    await execute(`fetch('/__fixture/fail')`)
    await wait(`document.querySelector('.run-list').innerText.includes('Retry runs')`)
    assert.equal(await execute(`window.__firstRunRow === document.querySelector('.automation-run')`), true)
    await execute(`fetch('/__fixture/release').then(() => document.querySelector('.run-list .text-button').click())`)
    await wait(`!document.querySelector('.run-list').innerText.includes('Retry runs') && document.querySelector('.runs-scroll').getAttribute('aria-busy') === 'false'`)
    await execute(`document.querySelector('.runs-scroll .tree-select').click()`)
    await wait(`document.querySelector('.runs-scroll .tree-select').getAttribute('aria-expanded') === 'false'`)
    await execute(`document.querySelector('.runs-scroll .tree-select').click()`)
    await wait(`document.querySelector('.runs-scroll .tree-select').getAttribute('aria-expanded') === 'true'`)
    assert.equal(await execute(`window.__firstRunRow === document.querySelector('.automation-run')`), true)
    window.setContentSize(390, 844)
    await frame()
    await wait(`!!document.querySelector('[aria-label="Toggle runs"]')`)
    assert.equal(await execute(`document.querySelector('.automation-explorer').getClientRects().length`), 0)
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
    await screenshot('automation-run-mobile')
    await execute(`document.querySelector('.run-tab:last-child [role="tab"]').scrollIntoView({block:'nearest',inline:'nearest'})`)
    await frame()
    assert.equal(await execute(`(() => {const r=document.querySelector('.run-tab:last-child [role="tab"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth})()`), true, 'Run tabs remain reachable in the horizontal strip')
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
    await execute(`document.querySelector('[aria-label="Toggle runs"]').click()`)
    await wait(`document.querySelector('.automation-explorer').getClientRects().length > 0`)
    await screenshot('automation-runs-mobile')
    await execute(`document.querySelector('.automation-info summary').click()`)
    await wait(`document.querySelector('.automation-info').open`)
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
    await screenshot('automation-details-mobile')
    await execute(`document.querySelector('[data-session-id="cron:run-2"]').click()`)
    await wait(`document.querySelectorAll('.run-tab').length === 3 && document.querySelector('.automation-explorer').getClientRects().length === 0`)
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
    window.setContentSize(1280, 844)
    await frame()
    await execute(`window.__automationRouter.push({name:'chat',params:{projectId:'fixture',sessionId:'cron:run-64'},query:{automation:'cron:weekly'}})`)
    await wait(`document.querySelectorAll('.run-tab').length === 4`)
    assert.equal(await execute(`window.__automationRouter.currentRoute.value.params.sessionId`), 'cron:run-64', 'Deep links do not retarget to a run from the loaded window')
    await execute(`document.querySelector('.run-tab.selected .tab-close').click()`)
    await wait(`document.querySelectorAll('.run-tab').length === 3`)
    assert.equal(await execute(`window.__automationRouter.currentRoute.value.params.sessionId`), 'cron:run-2')
    await execute(`window.__automationRouter.push({name:'chat',params:{projectId:'fixture',sessionId:'web:ordinary'}})`)
    await wait(`!document.querySelector('.automation-toolbar') && Array.from(document.querySelectorAll('.conversation-tab')).some(tab => tab.getClientRects().length > 0)`)
    assert.equal(await execute(`!!document.querySelector('.changes-tab, .session-file-changes')`), false)
    assert.equal(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.changes)`), 0, 'Neither ordinary conversations nor automation runs request write history')
    console.log('AUTOMATION_WORKSPACE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
