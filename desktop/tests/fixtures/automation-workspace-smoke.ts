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
  window.webContents.on('console-message', details => { if (details.level === 'warning' || details.level === 'error') errors.push(details.message) })
  const execute = async (code: string) => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (cause) { throw new Error(`Renderer script failed: ${code}`, { cause }) }
  }
  const wait = async (code: string) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const selected = () => execute('window.__automationRouter.currentRoute.value.params.sessionId')
  const click = (selector: string) => execute(`window.__visible(${JSON.stringify(selector)}).click()`)
  const go = async (id: string) => {
    await execute(`window.__automationRouter.push({name:'chat',params:{projectId:'fixture',sessionId:${JSON.stringify(id)}},query:{automation:'cron:weekly'}})`)
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes(${JSON.stringify(`Synthetic run result ${id}`)})`)
  }
  const screenshot = async (name: string) => {
    await frame()
    if (process.env.AUTOMATION_SCREENSHOTS) await writeFile(join(process.env.AUTOMATION_SCREENSHOTS, name + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  const noRunLayout = async () => {
    assert.equal(await execute(`!!document.querySelector('.automation-explorer, .automation-toolbar, .run-tab, [aria-label="Toggle runs"]')`), false)
    assert.equal(await execute(`document.querySelectorAll('.child-conversation').length`), 0)
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
  }
  try {
    await window.loadURL(new URL('__automations', process.env.AUTOMATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.automation-empty')`)
    await execute(`window.__visible = selector => Array.from(document.querySelectorAll(selector)).find(node => node.getClientRects().length > 0); undefined`)
    await noRunLayout()
    await execute(`fetch('/__fixture/release')`)
    await wait(`!!window.__visible('.conversation-skeleton') && !!window.__visible('.learning-outcome')`)
    assert.equal(await selected(), 'cron:run-0', 'Selecting an automation opens the latest run without another click')
    assert.equal(await execute(`window.__visible('.learning-outcome').innerText.includes('Partial')`), true)
    assert.equal(await execute(`document.querySelector('.automation-info').open`), false)
    assert.equal(await execute(`window.__visible('[aria-label="View previous session"]').disabled`), true, 'History cannot change while the conversation is loading')
    await execute(`fetch('/__fixture/history')`)
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-0') && !window.__visible('.conversation-skeleton')`)
    await wait(`!!window.__visible('.explorer-toggle')`)
    assert.equal(await execute(`window.__visible('.explorer-toggle').getAttribute('aria-expanded')`), 'true', 'Automations use the ordinary file explorer default')
    assert.equal(await execute(`!!window.__visible('.conversation-tab')`), true)
    assert.equal(await execute(`!!window.__visible('.workbench-editor > .document-toolbar')`), true)
    assert.equal(await execute(`window.__visible('[aria-label="Back to current session"]').disabled`), true)
    assert.deepEqual(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.offsets)`), [0], 'Opening the latest run does not fetch all historical pages')
    await click('[aria-label="View previous session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-1' && !!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-1')`)
    assert.equal(await execute(`window.__visible('.learning-outcome').innerText.includes('No verified learning receipt')`), true)
    await click('[aria-label="View previous session"]')
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result compact:run-1')`)
    assert.equal(await selected(), 'cron:run-1', 'Physical compaction history still belongs to its own run')
    await click('[aria-label="View next session"]')
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-1')`)
    assert.equal(await selected(), 'cron:run-1', 'Next from a compacted segment returns to the same run, not the latest run')
    await click('[aria-label="View next session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-0'`)
    await go('cron:run-29')
    await click('[aria-label="View previous session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-30' && !!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-30')`)
    await click('[aria-label="View next session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-29'`)
    await go('cron:run-64')
    await wait(`window.__visible('[aria-label="View previous session"]').disabled && !window.__visible('.segment-nav').getAttribute('aria-busy')?.includes('true')`)
    assert.equal(await selected(), 'cron:run-64', 'Deep links resolve older pages without retargeting to a loaded run')
    await click('[aria-label="Back to current session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-0'`)
    await click('.automation-info summary')
    await wait(`window.__visible('.automation-info').open`)
    assert.equal(await execute(`window.__visible('.automation-info').innerText.includes('Review recent work')`), true)
    assert.equal(await selected(), 'cron:run-0')
    await execute(`fetch('/__fixture/hold').then(() => window.__visible('.automation-info .btn').click())`)
    await wait(`window.__visible('.segment-nav').getAttribute('aria-busy') === 'true'`)
    assert.equal(await execute(`window.__visible('.chat-messages').innerText.includes('Synthetic run result cron:run-0')`), true)
    await execute(`fetch('/__fixture/fail')`)
    await wait(`Array.from(document.querySelectorAll('.automation-note')).some(node => node.getClientRects().length && node.innerText.includes('Retry history'))`)
    assert.equal(await selected(), 'cron:run-0')
    await execute(`fetch('/__fixture/release').then(() => Array.from(document.querySelectorAll('.automation-note .btn')).find(button => button.getClientRects().length && button.innerText === 'Retry history').click())`)
    await wait(`!window.__visible('.automation-note') && window.__visible('.segment-nav').getAttribute('aria-busy') === 'false'`)
    await click('.automation-info summary')
    await noRunLayout()
    await screenshot('automation-conversation-desktop')
    window.setContentSize(390, 844)
    await frame()
    await click('[aria-label="View previous session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-1'`)
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-1')`)
    await noRunLayout()
    assert.equal(await execute(`window.__visible('[aria-label="Back to current session"]').getBoundingClientRect().width >= 44`), true)
    await screenshot('automation-conversation-mobile')
    await click('[aria-label="Back to current session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-0'`)
    window.setContentSize(1280, 844)
    await frame()
    await execute(`window.__automationRouter.push({name:'chat',params:{projectId:'fixture',sessionId:'web:ordinary'}})`)
    await wait(`!!window.__visible('.conversation-tab') && !window.__visible('.automation-context') && !window.__visible('.segment-nav')`)
    assert.equal(await execute(`!!document.querySelector('.changes-tab, .session-file-changes')`), false)
    assert.equal(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.changes)`), 0)
    await execute(`fetch('/__fixture/empty').then(() => window.__automationRouter.push({name:'chat',params:{projectId:'fixture'},query:{automation:'cron:weekly'}}))`)
    await wait(`!!document.querySelector('.automation-empty')?.innerText.includes('No saved runs yet')`)
    assert.equal(await execute(`!!window.__visible('.chat-workspace')`), false, 'An empty automation does not create a draft conversation')
    await click('.automation-empty .automation-info summary')
    assert.equal(await execute(`document.querySelector('.automation-empty').innerText.includes('Review recent work')`), true, 'Automation metadata remains accessible before the first run')
    await noRunLayout()
    assert.deepEqual(errors.filter(message => !message.includes('vite') && !message.includes('Electron Security Warning')), [], 'No Vue warnings or renderer errors')
    console.log('AUTOMATION_WORKSPACE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
