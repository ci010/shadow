import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

interface DomNode { nodeId: number; nodeName: string; children?: DomNode[]; contentDocument?: DomNode }
function nodes(node: DomNode): DomNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes), ...(node.contentDocument ? nodes(node.contentDocument) : [])]
}

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  const startupWatchdog = setTimeout(() => {
    console.error('Electron startup did not reach app.whenReady or create a renderer within 60 seconds.')
    app.exit(1)
  }, 60000)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  window.setContentSize(1440, 900)
  const failures: string[] = []
  const pendingRequests = new Map<string, string>()
  window.webContents.debugger.attach('1.3')
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') failures.push(JSON.stringify(params.exceptionDetails))
    if (method === 'Network.requestWillBeSent') pendingRequests.set(params.requestId, params.request.url)
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') pendingRequests.delete(params.requestId)
    if (method === 'Network.responseReceived' && params.response.status >= 400) {
      failures.push(`${params.response.status} ${params.response.url}`)
    }
  })
  clearTimeout(startupWatchdog)
  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ failures, pendingRequests: [...pendingRequests.values()] }))
    window.destroy()
    app.exit(1)
  }, 85000)
  const execute = (code: string) => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`Fixture expression failed: ${code}`, { cause: error }) })
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(`Boolean(${code})`)) return; await delay(30) }
    const questions = await execute(`(() => {
      const found = [], seen = new Set();
      function walk(node) {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const instance = node.component;
        if (instance?.type?.__name === 'YieldQuestion') found.push({
          active: instance.props.active, stage: instance.props.stage,
          visible: instance.setupState.documentVisible, enabled: instance.setupState.enabled,
          request: instance.setupState.request?.id, error: instance.setupState.error
        });
        if (instance) walk(instance.subTree);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      }
      walk(document.querySelector('#app').__vue_app__?._instance?.subTree);
      return found;
    })()`)
    throw new Error(`Timed out: ${code}\nQuestions: ${JSON.stringify(questions)}\nPending: ${JSON.stringify([...pendingRequests.values()])}\nFixture: ${await execute('JSON.stringify({ready:document.readyState,fixture:!!window.fixture,app:!!document.querySelector("#app")?.__vue_app__})')}\nRenderer failures: ${failures.join('\n')}\nVisibility: ${await execute('document.visibilityState')}\n${await execute('document.body.innerText')}`)
  }
  const click = (text: string, scope = '') => execute(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${scope ? scope + ' ' : ''}button`)})].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
    button.click();
  })()`)
  const fill = (selector: string, value: string) => execute(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) throw new Error('Missing field: ' + ${JSON.stringify(selector)});
    field.focus(); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const separator = '.project-coordinator-panel > [role="separator"]'
  const paneWidth = () => execute('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width')
  const resizeKey = (key: string) => execute(`document.querySelector('${separator}').dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true}))`)
  const pointer = (type: string, point: { x: number; y: number }, pressed: boolean) =>
    window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: pressed ? 1 : 0, clickCount: 1 })
  const viewport = async (width: number) => {
    window.setContentSize(width, 900)
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await wait(`window.innerWidth === ${width}`)
  }
  const startDrag = async () => {
    const point = await execute(`(() => { const r = document.querySelector('${separator}').getBoundingClientRect(); return { x:Math.round(r.x + r.width/2), y:Math.round(r.y + 80) }; })()`)
    await pointer('mouseMoved', point, false)
    await pointer('mousePressed', point, true)
    await wait('document.documentElement.classList.contains("sidebar-pointer-resizing")')
    return point
  }
  const screenshot = async (state: string) => {
    for (const width of [1440, 390]) {
      await viewport(width)
      if (width < 1000) {
        await wait('document.querySelector(".project-dashboard-shell").classList.contains("compact")')
        await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]")?.click()')
      }
      await wait('document.querySelector(".workbench-toolbar .work-refresh")?.textContent.trim() === "Refresh"')
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
    await viewport(1440)
    await wait('!document.querySelector(".project-dashboard-shell").classList.contains("compact")')
    await click('Coordinator')
    await wait(`document.querySelector('${separator}')`)
  }
  const question = '[data-request-id="fixture-decision"]'
  const input = '[data-request-id="fixture-input"]'
  const advance = () => execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({advance:true}) }).then(() => window.invalidateWork())`)
  try {
    const loading = window.loadURL(new URL('__work', process.env.WORK_SMOKE_URL).href)
    await window.webContents.debugger.sendCommand('Runtime.enable')
    await window.webContents.debugger.sendCommand('Network.enable')
    await loading
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await viewport(1440)
    await wait('document.querySelector(".topic-history details summary")')
    assert.equal(await execute('document.querySelector(".work-view-switch [aria-pressed=true]").textContent.trim()'), 'Dashboard')
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Reports and execution status are not user acceptance/)
    assert.match(await execute('document.querySelector(".topic-history details summary").textContent'), /Token measurements are ready/)
    await wait('document.querySelector(".quick-actions.pinned .action-row")')
    assert.equal(await execute('!!document.querySelector(".quick-actions.pinned [role=alert]")'), false)
    assert.equal(await execute('!!document.querySelector(".quick-actions.pinned .scope")'), false)
    assert.ok(await execute('document.querySelector(".quick-actions.pinned").getBoundingClientRect().height') < 130)
    assert.equal(await execute('!!document.querySelector(".work-diagnostics")'), false, 'Internal reviews are not homepage tasks')
    await click('Agent diagnostics')
    assert.equal(await execute('document.querySelector(".work-diagnostics").open'), false)
    await execute('document.querySelector(".work-diagnostics").open = true')
    assert.match(await execute('document.querySelector(".work-diagnostics").textContent'), /Agents reassess.*do not need to fill in a review/)
    assert.equal(await execute('document.querySelector(".work-attention summary").textContent.trim()'), 'Needs your attention · 2')
    await click('Agent diagnostics')
    await execute('document.querySelector(".topic-history details").open = true')
    await wait('document.querySelector(".topic-history").textContent.includes("Human answer")')
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Parent model answer/)
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Timeout default \(not a human or model choice\)/)
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Pending — no decision recorded/)
    assert.equal(await execute('document.querySelectorAll(".work-view-switch button").length'), 2, 'Only overview and issue-style board are main views')
    assert.equal(await execute('document.querySelector(".advanced-views")'), null)
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Internal structure/)
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Cross-topic dependency/)
    assert.equal(await execute('window.organizationCalls ?? 0'), 0, 'Opening never calls organization')
    await click('Organize recent topics')
    await wait('document.querySelector(".organization-status").textContent.includes("The model returned incomplete or invalid JSON")')
    assert.equal(await execute('document.querySelector(".organization-status").textContent.includes("private provider text")'), false)
    assert.equal(await execute('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Organize recent topics").disabled'), false)
    await click('Organize recent topics')
    await wait('document.querySelector(".organization-status").textContent.includes("Recent topics organized")')
    assert.equal(await execute('window.organizationCalls'), 2)
    assert.match(await execute('document.querySelector(".focus-group h2").textContent'), /Understand release effects/)
    assert.match(await execute('document.querySelector(".topic-history").textContent'), /Model interpretation — not confirmed user intent/)
    assert.equal(await execute('document.querySelector(".advanced-views")'), null)
    await click('Dashboard', '.work-view-switch')
    await wait('document.querySelector(".overview-structure")')
    await execute('document.querySelector(".overview-structure").open = true')
    await wait(`document.querySelector('${question} .yield-prompt') && document.querySelector('${input} textarea')`)
    assert.equal(await execute(`document.querySelector('${question}').closest('[data-work-key]').dataset.workKey === window.fixtureKeys.root`), true)
    assert.match(await execute(`document.querySelector('${question} .yield-prompt').textContent`), /release report wait/)
    assert.equal(await execute(`document.querySelector('${question} .technical-origin').open`), false)
    assert.match(await execute(`document.querySelector('${question} .path-warning').innerText`), /not yet reassessed.*Prepare a grader/)
    assert.equal(await execute(`document.querySelector('${question} .path-warning').getClientRects().length > 0`), true,
      'An unassessed technical premise is visible without opening the technical detail')
    assert.equal(await execute(`!!document.querySelector('[data-work-key="' + window.fixtureKeys.grader + '"]')`), false, 'Deep implementation branches start collapsed')
    await execute(`document.querySelector('${question} .technical-origin').open = true`)
    assert.match(await execute(`document.querySelector('${question} .technical-origin').textContent`), /Scored evaluation was assumed to be necessary/)
    await execute(`document.querySelector('${question} .technical-origin').open = false`)
    assert.equal(await execute(`document.querySelector('[data-session-work="reporting"], [data-session-work="work"]')`), null)
    assert.match(await execute('document.body.innerText'), /Needs your attention/)
    assert.match(await execute('document.querySelector(".project-activity").textContent'), /Untracked conversation/)
    assert.match(await execute('document.querySelector(".project-activity .child-activity").textContent'), /Inspect inputs.*Delegated by.*Untracked conversation/)
    assert.match(await execute('document.querySelector(".observer-status").textContent'), /Organizing observed work/)
    assert.match(await execute('document.body.innerText'), /Automatically observed/)
    await execute('document.querySelector(".observation-source").open = true')
    assert.match(await execute('document.querySelector(".observation-source").textContent'), /observed-input/)
    assert.equal(await execute('document.querySelector(".project-dashboard-tabs .document-tab [role=tab]").textContent.trim()'), 'Dashboard')
    await wait(`document.querySelector('${separator}')`)
    assert.equal(await paneWidth(), 400)
    assert.equal(await execute(`document.querySelector('${separator}').getAttribute('aria-controls') === document.querySelector('.project-coordinator-panel').id`), true)
    const drag = await startDrag()
    await pointer('mouseMoved', { x: drag.x - 160, y: drag.y }, true)
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    await pointer('mouseReleased', { x: drag.x - 160, y: drag.y }, false)
    await wait('!document.documentElement.classList.contains("sidebar-pointer-resizing")')
    assert.equal(await execute('document.querySelector("#fixture-composer").value'), 'Keep my unsent draft')
    await resizeKey('ArrowLeft'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 584')
    await resizeKey('ArrowRight'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    await resizeKey('End'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 640')
    await viewport(1000)
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 400')
    assert.equal(await execute('document.querySelector(".project-dashboard-tabs").getBoundingClientRect().width'), 600)
    await viewport(1440)
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 640')
    await resizeKey('Home'); await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 320')
    for (let step = 0; step < 10; step++) { await resizeKey('ArrowLeft'); await delay(10) }
    await wait('document.querySelector(".project-coordinator-panel").getBoundingClientRect().width === 560')
    const interrupted = await startDrag()
    await execute('window.fixture.visible = false')
    await wait(`!document.querySelector('${separator}') && !document.documentElement.classList.contains('sidebar-pointer-resizing')`)
    await pointer('mouseReleased', interrupted, false)
    await execute('window.fixture.visible = true')
    await wait(`document.querySelector('${separator}')`)
    await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
    assert.equal(await execute(`!!document.querySelector('${separator}')`), false)
    await click('Coordinator')
    await wait(`document.querySelector('${separator}')`)
    assert.equal(await paneWidth(), 560)
    await execute('window.navigateTab("settings")')
    await wait('document.querySelector(".project-settings-view")?.getClientRects().length')
    assert.equal(await execute('document.querySelectorAll(".project-dashboard-tabs .document-tab [role=tab]").length'), 2, 'Dashboard and settings share one tab strip')
    assert.equal(await execute('document.querySelector("#fixture-composer").getClientRects().length > 0'), true, 'Coordinator stays visible across tabs')
    assert.equal(await execute('document.querySelector("#fixture-composer").value'), 'Keep my unsent draft')
    await execute('[...document.querySelectorAll(".project-dashboard-tabs .document-tab [role=tab]")].find(tab => tab.textContent.trim() === "Dashboard").click()')
    await wait('document.querySelector(".workbench-main").getClientRects().length')
    await execute('document.querySelector(".overview-graph").open = true')
    await wait('document.querySelectorAll(".graph-node").length === 5')
    assert.equal(await execute('document.querySelectorAll("svg > path.dependency").length'), 2)
    await execute('document.querySelector(".overview-graph").open = false')
    await click('Board')
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 4')
    await execute(`(() => { const select = document.querySelectorAll('.work-filters select')[1]; select.value = 'unassigned'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 2')
    await execute(`(() => { const select = document.querySelectorAll('.work-filters select')[1]; select.value = ''; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    assert.equal(await execute('document.querySelector(".advanced-views")'), null)
    await click('Dashboard', '.work-view-switch')
    await wait('document.querySelector(".overview-structure")')
    await execute('document.querySelector(".overview-structure").open = true')
    await wait(`document.querySelector('${question} input[type=radio]')`)
    await execute(`document.querySelector('${question} input[type=radio]').dispatchEvent(new KeyboardEvent('keydown', { key:'a', bubbles:true, cancelable:true }))`)
    assert.equal(await execute(`document.querySelector('${question} input:checked').value`), 'Wait for a grader')
    await execute(`document.querySelector('${question} .yield-custom-toggle').click()`)
    await wait(`document.querySelector('${question} .yield-custom textarea')`)
    await fill(`${question} .yield-custom textarea`, 'Compare token usage; a grader is not required.')
    await execute(`window.answerDraft = document.querySelector('${question} .yield-custom textarea')`)
    await advance()
    await wait('document.querySelector(".context-canvas").textContent.includes("Usage report is ready")')
    assert.equal(await execute(`window.answerDraft === document.querySelector('${question} .yield-custom textarea')`), true)
    assert.equal(await execute('window.answerDraft.value'), 'Compare token usage; a grader is not required.', 'Live note refresh keeps the current answer draft')
    assert.equal(await execute('document.activeElement === window.answerDraft'), true, 'Routine updates do not steal focus')
    assert.equal(await execute(`!!document.querySelector('[data-work-key="' + window.fixtureKeys.grader + '"]')`), false, 'A note refresh does not unfold a collapsed branch')
    await execute('document.querySelector(".context-canvas").scrollTop = 0')
    await screenshot('overview')
    assert.equal(await paneWidth(), 560, 'Returning from compact mode preserves the preferred pane width')
    await wait(`document.querySelector('${question} .yield-custom textarea')`)
    assert.equal(await execute(`document.querySelector('${question} .yield-custom textarea').value`), 'Compare token usage; a grader is not required.',
      'Temporarily hiding the dashboard in compact mode preserves the custom answer instead of selecting the default')

    const goal = `[data-work-key="${await execute('window.fixtureKeys.root')}"]`
    await click('Inspect notes', goal)
    await execute(`document.querySelector('${goal} .work-exhibit').open = true`)
    await wait(`document.querySelector('${goal} iframe')`)
    assert.equal(await execute(`document.querySelector('${goal} iframe').getAttribute('sandbox')`), '')
    let frame = window.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    const frameDeadline = Date.now() + 10000
    while (!frame && Date.now() < frameDeadline) {
      await delay(30)
      frame = window.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    }
    assert.ok(frame, 'The HTML exhibit has a separate frame')
    await assert.rejects(frame.executeJavaScript('window.__exhibitScriptRan = true'), error => String(error).includes('Script not run'),
      'The sandbox disallows JavaScript, including access to host bridges')
    assert.equal(await execute(`document.querySelector('${goal} iframe').contentDocument === null`), true, 'The exhibit has an opaque origin')
    const targets: { targetInfos: { type: string; url: string; targetId: string }[] } = await window.webContents.debugger.sendCommand('Target.getTargets')
    const target = targets.targetInfos.find(target => target.type === 'iframe' && target.url === 'about:srcdoc')
    assert.ok(target, 'The opaque exhibit has its own renderer target')
    const { sessionId } = await window.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    await window.webContents.debugger.sendCommand('DOM.enable', {}, sessionId)
    await window.webContents.debugger.sendCommand('CSS.enable', {}, sessionId)
    const document: { root: DomNode } = await window.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 }, sessionId)
    const exhibitNodes = nodes(document.root)
    assert.equal(exhibitNodes.some(node => ['SCRIPT', 'FORM', 'INPUT', 'BUTTON', 'A', 'IFRAME', 'OBJECT', 'EMBED', 'foreignObject'].includes(node.nodeName)), false)
    const body = exhibitNodes.find(node => node.nodeName === 'BODY')
    assert.ok(body)
    const colors: string[] = []
    for (const dark of [false, true]) {
      await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
      await delay(100)
      const styles: { computedStyle: { name: string; value: string }[] } = await window.webContents.debugger.sendCommand('CSS.getComputedStyleForNode', { nodeId: body.nodeId }, sessionId)
      colors.push(styles.computedStyle.find(style => style.name === 'background-color')!.value)
      assert.equal(await execute(`getComputedStyle(document.querySelector('${goal} iframe')).colorScheme`), dark ? 'dark' : 'light')
    }
    assert.notEqual(colors[0], colors[1], 'The rendered exhibit follows the host theme')
    assert.equal(await execute('window.__exhibitEscaped'), undefined)
    await execute(`document.querySelector('${goal} .work-exhibit').open = false`)
    await click('Less detail', goal)
    await execute(`document.querySelector('${question} form').requestSubmit()`)
    await wait(`!document.querySelector('${question}')`)

    await click('Evaluate release candidates', '.node-heading')
    assert.equal(await paneWidth(), 560, 'Work details do not replace or resize the coordinator')
    await wait('document.querySelector(".work-alignment")?.innerText.includes("Compare release candidates")')
    assert.match(await execute('document.querySelector(".work-alignment").innerText'), /Working interpretation/)
    await execute('document.querySelector(".reporting-settings").open = true; document.querySelector(".decision-owner").open = true')
    await wait('document.querySelector(".decision-owner select")')
    assert.match(await execute('document.querySelector(".decision-owner").textContent'), /Assigned to: web:fixture/)
    await execute(`(() => { const select = document.querySelector('.decision-owner select'); select.value = 'web:reviewer'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await click('Save responsibility')
    await wait('document.querySelector(".decision-owner").textContent.includes("Assigned to: web:reviewer")')
    await click('Edit note', '.work-alignment')
    await fill('.note-editor textarea', 'Corrected final outcome')
    await execute(`(() => { const confirm = window.confirm; window.confirm = () => false;
      return window.navigateWork(window.fixtureKeys.root).finally(() => { window.confirm = confirm; }).then(() => true); })()`)
    assert.equal(await execute('document.querySelector(".note-editor textarea").value'), 'Corrected final outcome', 'Cancelled navigation retains the note draft')
    await advance()
    await wait('document.querySelector(".note-editor").textContent.includes("Discard draft and load latest")')
    await wait('!document.querySelector(".work-alignment button").disabled')
    assert.equal(await execute('document.querySelector(".note-editor textarea").value'), 'Corrected final outcome')
    await click('Discuss')
    await wait('document.querySelector("#fixture-composer").getClientRects().length')
    assert.match(await execute('document.querySelector("#fixture-composer").value'), /Keep my unsent draft[\s\S]*About work topic:web:fixture/)
    await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
    await wait('!document.querySelector(".work-alignment button").disabled')
    await execute('document.querySelector(".note-editor").requestSubmit()')
    await wait(`document.querySelector('.work-alignment [role="alert"]')?.textContent.includes('note changed')`)
    assert.equal(await execute('document.querySelector(".note-editor textarea").value'), 'Corrected final outcome')
    await click('Discard draft and load latest', '.note-editor')
    assert.equal(await execute('document.querySelector(".note-editor textarea").value'), 'Compare release candidates using the available measurements')
    await fill('.note-editor textarea', 'Corrected final outcome')
    await execute('document.querySelector(".note-editor").requestSubmit()')
    await wait('!document.querySelector(".note-editor") && document.querySelector(".work-alignment").innerText.includes("User-defined goal")')
    await wait('!document.querySelector(".work-alignment button").disabled')
    await fill('.work-alignment form textarea', 'Token metrics can continue without a grader')
    await click('Record assessment', '.work-alignment')
    await wait('!document.querySelector(".work-alignment form")')
    await execute('window.setAdmin(false)')
    await wait(`![...document.querySelectorAll('.work-alignment button')].some(button => button.textContent.trim() === 'Edit note')`)
    await execute('document.querySelector("[aria-label=\\"Close coordination panel\\"]").click()')
    await wait('document.querySelector(".workbench-main").getClientRects().length')
    await wait(`document.querySelector('${input} fieldset')?.disabled`)
    assert.equal(await execute(`!!document.querySelector('${input} button[type=submit]')`), false, 'Read-only sessions cannot answer through the canvas')
    assert.equal(await execute('!!document.querySelector(".context-canvas .node-actions button:nth-child(2)")'), false, 'Read-only sessions cannot edit through the canvas')
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({unavailable:true}) }).then(() => window.invalidateWork())`)
    await wait('document.querySelector(".workbench-error")')
    assert.equal(await execute('document.querySelectorAll(".context-node").length'), 5, 'Failures retain the last snapshot with an explicit warning')
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({empty:true,unavailable:false}) }).then(() => window.invalidateWork())`)
    await wait('document.body.innerText.includes("There is no goal map yet")')
    assert.match(await execute('document.querySelector(".project-activity").textContent'), /Untracked conversation/)
    assert.match(await execute('document.querySelector(".unlinked-questions").textContent'), /Which report should be attached/)
    await execute('window.showProjectDelete()')
    await wait('document.querySelector(".project-delete-dialog")?.open')
    assert.equal(await execute('document.activeElement.textContent'), 'Cancel', 'Destructive dialog initially focuses Cancel')
    assert.equal(await execute('document.querySelector(".delete-confirm").disabled'), true)
    await execute(`(() => { const input = document.querySelector('.project-delete-dialog input');
      input.value = 'Release evidence'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await wait('!document.querySelector(".delete-confirm").disabled')
    await click('Delete project')
    await wait('document.querySelector(".delete-error")?.textContent.includes("Stop active")')
    assert.equal(await execute('document.querySelector(".project-delete-dialog input").value'), 'Release evidence')
    await click('Delete project')
    await wait('window.fixture.deleted && !document.querySelector(".project-delete-dialog")')
    await execute('window.fixture.visible = false')
    console.log('WORK_SMOKE_OK')
  } finally { clearTimeout(watchdog); window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
