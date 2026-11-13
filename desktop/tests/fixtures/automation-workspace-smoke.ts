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
    assert.equal(await execute(`document.querySelector('.automation-info, .automation-projection')`), null)
    assert.equal(await execute(`document.body.textContent.includes('this page shows conversation history only')`), false)
  }
  try {
    await window.loadURL(new URL('__automations', process.env.AUTOMATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.automation-empty')`)
    await execute(`window.__visible = selector => Array.from(document.querySelectorAll(selector)).find(node => node.getClientRects().length > 0); undefined`)
    await noRunLayout()
    await execute(`fetch('/__fixture/release'); undefined`)
    await wait(`!!window.__visible('.conversation-skeleton')`)
    assert.equal(await execute(`document.querySelectorAll('.automation-result-message').length`), 0, 'Results wait for their own conversation history')
    assert.equal(await selected(), 'cron:run-0', 'Selecting an automation opens the latest run without another click')
    assert.equal(await execute(`document.querySelector('.automation-info, .automation-projection, .automation-context')`), null)
    assert.equal(await execute(`window.__visible('[aria-label="View previous session"]').disabled`), true, 'History cannot change while the conversation is loading')
    await execute(`fetch('/__fixture/history')`)
    await wait(`window.__visible('.chat-history')?.getAttribute('aria-busy') === 'false'`)
    // Long completion receipts follow latest. Scroll earlier content into view:
    // content-visibility intentionally omits offscreen rows from innerText.
    await execute(`window.__visible('.chat-messages').scrollTop = 0`)
    await frame()
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-0') && !window.__visible('.conversation-skeleton')`)
    await wait(`!!window.__visible('.automation-result-message')`)
    assert.equal(await execute(`document.querySelectorAll('.chat-message-list .automation-result-message').length`), 1)
    assert.equal(await execute(`window.__visible('.automation-result-message').innerText.includes('Partial')`), true)
    assert.equal(await execute(`window.__visible('.automation-result-message').dataset.resultSource`), 'metadata')
    assert.equal(await execute(`!!window.__visible('.automation-context')`), false)
    assert.equal(await execute(`window.__visible('.automation-result-message').previousElementSibling.innerText.includes('Synthetic run result cron:run-0')`), true)
    assert.equal(await execute(`window.__visible('.automation-result-message').innerText.includes('END OF LONG SUMMARY')`), true)
    assert.equal(await execute(`getComputedStyle(window.__visible('.automation-result-message .message-preview-content')).maxHeight`), 'none')
    await execute(`window.__visible('.automation-result-message [aria-label="Copy Markdown"]').focus()`)
    assert.equal(await execute(`document.activeElement.getAttribute('aria-label')`), 'Copy Markdown')
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'})
    window.webContents.sendInputEvent({type:'char',keyCode:'\r'})
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'})
    await wait(`window.__copied.endsWith('END OF LONG SUMMARY')`)
    assert.equal(await execute(`window.__copied.length > 5000`), true, 'Keyboard copy retains the entire long summary')
    await wait(`!!window.__visible('.explorer-toggle')`)
    assert.equal(await execute(`window.__visible('.explorer-toggle').getAttribute('aria-expanded')`), 'false', 'Automations use the current ordinary closed explorer default')
    await click('.explorer-toggle')
    assert.equal(await execute(`window.__visible('.explorer-toggle').getAttribute('aria-expanded')`), 'true', 'The ordinary file explorer can still be opened')
    assert.equal(await execute(`!!window.__visible('.conversation-tab')`), true)
    assert.equal(await execute(`!!window.__visible('.workbench-editor > .document-toolbar')`), true)
    assert.equal(await execute(`window.__visible('[aria-label="Back to current session"]').disabled`), true)
    assert.deepEqual(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.offsets)`), [0], 'Opening the latest run does not fetch all historical pages')
    await click('[aria-label="View previous session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-1' && !!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result cron:run-1')`)
    assert.equal(await execute(`!!window.__visible('.automation-info')`), false)
    // Short current segments now seed their older segment in the continuous timeline.
    await execute(`window.__visible('.chat-messages').scrollTop = 0`)
    await frame()
    await wait(`!!window.__visible('.chat-messages')?.innerText.includes('Synthetic run result compact:run-1')`)
    assert.equal(await selected(), 'cron:run-1', 'Seeded physical history still belongs to its own run')
    assert.equal(await execute(`document.querySelectorAll('.chat-message-list .automation-result-message').length`), 1, 'Older physical history does not duplicate the run result')
    await click('[aria-label="View next session"]')
    await wait(`window.__automationRouter.currentRoute.value.params.sessionId === 'cron:run-0'`)
    await go('cron:run-2')
    assert.equal(await execute(`window.__visible('.automation-result-message').innerText.includes('Failed')`), true)
    assert.equal(await execute(`document.querySelectorAll('.chat-message-list .automation-result-message').length`), 1)
    assert.equal(await execute(`window.__visible('.chat-messages').textContent.split('Synthetic run result cron:run-2').length - 1`), 1, 'Final response is not duplicated by result projection')
    await go('cron:run-3')
    assert.equal(await execute(`document.querySelectorAll('.automation-result-message').length`), 0, 'A running run has no final result yet')
    for (const [index, label] of [[4, 'Applied'], [5, 'No change'], [6, 'Blocked'], [7, 'Draft only'], [9, 'Cancelled']] as const) {
      await go(`cron:run-${index}`)
      assert.equal(await execute(`window.__visible('.automation-result-message').innerText.includes(${JSON.stringify(label)})`), true)
      assert.equal(await execute(`document.querySelectorAll('.chat-message-list .automation-result-message').length`), 1)
      assert.equal(await execute(`window.__visible('.chat-messages').textContent.split('Synthetic run result cron:run-${index}').length - 1`), 1, 'Matching final response and metadata summary appear once')
    }
    await execute(`window.__automationRouter.push({name:'chat',params:{projectId:'fixture',sessionId:'cron:run-8'},query:{automation:'cron:weekly'}})`)
    await wait(`window.__visible('.automation-result-message')?.dataset.resultKey.endsWith(':run-8')`)
    assert.equal(await execute(`window.__visible('.automation-result-message').textContent.includes('Completed')`), true, 'A terminal run without output still has its recorded status')
    assert.equal(await execute(`!!window.__visible('.automation-result-message .message-copy-actions')`), false, 'No invented summary or empty copy action')
    assert.equal(await execute(`window.__visible('.automation-result-message').textContent.includes('Synthetic run result compact:run-8')`), false, 'Seeded older output is not the empty current segment result')
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
    assert.equal(await execute(`document.querySelector('.automation-info, .automation-projection')`), null)
    await noRunLayout()
    await click('.explorer-toggle')
    await execute(`window.__visible('.automation-result-message').scrollIntoView({block:'start'})`)
    await screenshot('automation-conversation-desktop')
    window.setContentSize(390, 844)
    await frame()
    assert.equal(await execute(`window.__visible('.automation-result-message').getBoundingClientRect().width <= window.__visible('.chat-messages').clientWidth`), true, 'Long summary stays on the mobile conversation rail')
    await screenshot('automation-partial-mobile')
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
    assert.equal(await execute(`document.querySelectorAll('.automation-result-message').length`), 0, 'Ordinary conversations never inherit run results')
    assert.equal(await execute(`!!document.querySelector('.changes-tab, .session-file-changes')`), false)
    assert.equal(await execute(`fetch('/__fixture/stats').then(response => response.json()).then(value => value.changes)`), 0)
    await execute(`fetch('/__fixture/empty').then(() => window.__automationRouter.push({name:'chat',params:{projectId:'fixture'},query:{automation:'cron:weekly'}}))`)
    await wait(`!!document.querySelector('.automation-empty')?.innerText.includes('No saved runs yet')`)
    assert.equal(await execute(`!!window.__visible('.chat-workspace')`), false, 'An empty automation does not create a draft conversation')
    assert.equal(await execute(`document.querySelector('.automation-info, .automation-projection')`), null, 'Empty workflows have no conversation configuration surfaces')
    await noRunLayout()
    assert.deepEqual(errors.filter(message => !message.includes('vite') && !message.includes('Electron Security Warning')), [], 'No Vue warnings or renderer errors')
    console.log('AUTOMATION_WORKSPACE_OK')
  } finally { await execute('window.__disposeFixture?.()'); window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
