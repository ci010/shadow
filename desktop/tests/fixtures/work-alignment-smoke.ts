import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  window.setContentSize(1440, 900)
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(`Boolean(${code})`)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = (text: string) => execute(`(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
    button.click();
  })()`)
  const fill = (index: number, value: string) => execute(`(() => {
    const field = document.querySelectorAll('.work-alignment textarea')[${index}];
    field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const separator = '.project-coordinator-panel > [role="separator"]'
  const paneWidth = () => execute('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width')
  const resizeKey = (key: string) => execute(`document.querySelector('${separator}').dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true}))`)
  const startDrag = async () => {
    const point = await execute(`(() => { const r = document.querySelector('${separator}').getBoundingClientRect(); return { x:Math.round(r.x + r.width/2), y:Math.round(r.y + 80) }; })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    await wait('document.documentElement.classList.contains("sidebar-pointer-resizing")')
    return point
  }
  const screenshot = async (state: string) => {
    for (const width of [1440, 390]) {
      window.setContentSize(width, 900)
      if (width < 1000) {
        await wait('document.querySelector(".project-dashboard-shell").classList.contains("compact")')
        await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
      }
      await wait('document.querySelector(".workbench-toolbar > button")?.textContent.trim() === "Refresh"')
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await delay(90)
        assert.equal(await execute(`!!document.querySelector('${separator}')`), width >= 1000 && await execute('document.querySelector(".project-dashboard-shell").classList.contains("has-coordinator")'))
        assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${state} has no page overflow`)
        if (process.env.WORK_SCREENSHOTS) await writeFile(join(process.env.WORK_SCREENSHOTS,
          `workbench-${state}-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(1440, 900)
    await wait('!document.querySelector(".project-dashboard-shell").classList.contains("compact")')
    await click('Coordinator')
    await wait(`document.querySelector('${separator}')`)
  }
  try {
    await window.loadURL(new URL('__work', process.env.WORK_SMOKE_URL).href)
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 4')
    assert.equal(await execute(`document.querySelector('[data-session-work="reporting"], [data-session-work="work"]')`), null)
    assert.match(await execute('document.body.innerText'), /Unassigned/)
    assert.match(await execute('document.body.innerText'), /Needs your attention/)
    assert.equal(await execute('document.querySelector(".project-dashboard-tabs .document-tab [role=tab]").textContent.trim()'), 'Dashboard')
    await wait(`document.querySelector('${separator}')`)
    assert.equal(await paneWidth(), 400)
    assert.equal(await execute(`document.querySelector('${separator}').getAttribute('aria-controls') === document.querySelector('.project-coordinator-panel').id`), true)
    const drag = await startDrag()
    window.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x - 160, y: drag.y, button: 'left' })
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    window.webContents.sendInputEvent({ type: 'mouseUp', x: drag.x - 160, y: drag.y, button: 'left', clickCount: 1 })
    await wait('!document.documentElement.classList.contains("sidebar-pointer-resizing")')
    assert.equal(await execute('document.querySelector("#fixture-composer").value'), 'Keep my unsent draft')
    await resizeKey('ArrowLeft'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 584')
    await resizeKey('ArrowRight'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    await resizeKey('End'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 640')
    window.setContentSize(1000, 900)
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 400')
    assert.equal(await execute('document.querySelector(".project-dashboard-tabs").getBoundingClientRect().width'), 600)
    window.setContentSize(1440, 900)
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 640')
    await resizeKey('Home'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 320')
    for (let step = 0; step < 10; step++) { await resizeKey('ArrowLeft'); await delay(10) }
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    const interrupted = await startDrag()
    await execute('window.fixture.visible = false')
    await wait(`!document.querySelector('${separator}') && !document.documentElement.classList.contains('sidebar-pointer-resizing')`)
    window.webContents.sendInputEvent({ type: 'mouseUp', ...interrupted, button: 'left', clickCount: 1 })
    await execute('window.fixture.visible = true')
    await wait(`document.querySelector('${separator}')`)
    await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
    assert.equal(await execute(`!!document.querySelector('${separator}')`), false)
    await click('Coordinator')
    await wait(`document.querySelector('${separator}')`)
    assert.equal(await paneWidth(), 560)
    await screenshot('board')
    assert.equal(await paneWidth(), 560, 'Returning from compact mode preserves the preferred pane width')
    await execute('window.navigateTab("settings")')
    await wait('document.querySelector(".project-settings-view")?.getClientRects().length')
    assert.equal(await execute('document.querySelectorAll(".project-dashboard-tabs .document-tab [role=tab]").length'), 2, 'Dashboard and settings share one tab strip')
    assert.equal(await execute('document.querySelector("#fixture-composer").getClientRects().length > 0'), true, 'Coordinator stays visible across tabs')
    assert.equal(await execute('document.querySelector("#fixture-composer").value'), 'Keep my unsent draft')
    await execute('[...document.querySelectorAll(".project-dashboard-tabs .document-tab [role=tab]")].find(tab => tab.textContent.trim() === "Dashboard").click()')
    await wait('document.querySelector(".workbench-main").getClientRects().length')
    await click('Graph')
    await wait('document.querySelectorAll(".graph-node").length === 4')
    assert.equal(await execute('document.querySelectorAll("svg > path.dependency").length'), 1)
    await screenshot('graph')
    await click('Board')
    await execute(`(() => { const select = document.querySelectorAll('.work-filters select')[1]; select.value = 'unassigned'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 2')
    await execute(`(() => { const select = document.querySelectorAll('.work-filters select')[1]; select.value = ''; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await click('Run both evaluations')
    assert.equal(await paneWidth(), 560, 'Work details do not replace or resize the coordinator')
    await wait('document.querySelector(".work-alignment")?.innerText.includes("Agent-chosen next phase")')
    assert.match(await execute('document.querySelector(".work-alignment").innerText'), /Agent interpretation.*not a quoted user requirement/)
    assert.match(await execute('document.querySelector("[aria-label=\\"Pending work proposal\\"]").textContent'), /New execution: paused/)
    await screenshot('detail')
    await execute('document.querySelector(".reporting-settings").open = true; document.querySelector(".decision-owner").open = true')
    await wait('document.querySelector(".decision-owner select")')
    assert.match(await execute('document.querySelector(".decision-owner").textContent'), /Assigned to: web:fixture/)
    await execute(`(() => { const select = document.querySelector('.decision-owner select'); select.value = 'web:reviewer'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await click('Save responsibility')
    await wait('document.querySelector(".decision-owner").textContent.includes("Assigned to: web:reviewer")')
    await execute('document.querySelector(".advanced-work").open = true')
    await click('Fresh context')
    await click('Confirm fresh')
    await wait(`![...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Confirm fresh')`)
    await click('Revise work')
    await fill(0, 'Corrected final outcome')
    await fill(3, 'Conflict')
    await execute(`(() => { const confirm = window.confirm; window.confirm = () => false;
      return window.navigateWork('work:root').finally(() => { window.confirm = confirm; }).then(() => true); })()`)
    assert.equal(await execute('document.querySelector(".work-alignment textarea").value'), 'Corrected final outcome', 'Cancelled navigation retains the work revision')
    await execute('window.invalidateWork()')
    await wait('!document.querySelector(".work-alignment button").disabled')
    assert.equal(await execute('document.querySelector(".work-alignment textarea").value'), 'Corrected final outcome')
    await click('Discuss')
    await wait('document.querySelector("#fixture-composer").getClientRects().length')
    assert.match(await execute('document.querySelector("#fixture-composer").value'), /Keep my unsent draft[\s\S]*About work topic:web:fixture/)
    await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
    await wait('!document.querySelector(".work-alignment button").disabled')
    await execute('document.querySelector(".work-alignment form").requestSubmit()')
    await wait(`document.querySelector('.work-alignment [role="alert"]')?.textContent.includes('revision changed')`)
    assert.equal(await execute('document.querySelector(".work-alignment textarea").value'), 'Corrected final outcome')
    await fill(3, 'Correct agent interpretation, not a changed user request')
    await execute('document.querySelector(".work-alignment form").requestSubmit()')
    await wait('!document.querySelector(".work-alignment form") && document.querySelector(".work-alignment").innerText.includes("Human-confirmed agreement")')
    await execute('window.setAdmin(false)')
    await wait(`![...document.querySelectorAll('.work-alignment button')].some(button => button.textContent.trim() === 'Revise work')`)
    await execute('document.querySelector("[aria-label=\\"Close coordination panel\\"]").click()')
    await wait('document.querySelector(".workbench-main").getClientRects().length')
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({unavailable:true}) }).then(() => window.invalidateWork())`)
    await wait('document.querySelector(".workbench-error")')
    assert.equal(await execute('document.querySelectorAll(".work-board .work-item-card").length'), 4, 'Failures retain the last snapshot with an explicit warning')
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({empty:true}) }).then(() => window.invalidateWork())`)
    await wait('document.body.innerText.includes("No work items yet")')
    await screenshot('empty')
    await execute('window.showProjectDelete()')
    await wait('document.querySelector(".project-delete-dialog")?.open')
    assert.equal(await execute('document.activeElement.textContent'), 'Cancel', 'Destructive dialog initially focuses Cancel')
    assert.equal(await execute('document.querySelector(".delete-confirm").disabled'), true)
    await execute(`(() => { const input = document.querySelector('.project-delete-dialog input');
      input.value = 'Evaluation project'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await wait('!document.querySelector(".delete-confirm").disabled')
    await click('Delete project')
    await wait('document.querySelector(".delete-error")?.textContent.includes("Stop active")')
    assert.equal(await execute('document.querySelector(".project-delete-dialog input").value'), 'Evaluation project')
    await click('Delete project')
    await wait('window.fixture.deleted && !document.querySelector(".project-delete-dialog")')
    await execute('window.fixture.visible = false')
    console.log('WORK_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
