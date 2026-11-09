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
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const failures: string[] = []
  window.webContents.debugger.attach('1.3')
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') failures.push(JSON.stringify(params.exceptionDetails))
  })
  const watchdog = setTimeout(() => { console.error(failures); window.destroy(); app.exit(1) }, 85000)
  const execute = (code: string) => window.webContents.executeJavaScript(code).catch(error => {
    throw new Error(`Fixture expression failed: ${code}\nRenderer failures: ${failures.join('\n')}`, { cause: error })
  })
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(`Boolean(${code})`)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\nRenderer failures: ${failures.join('\n')}\n${await execute('document.body.innerText')}`)
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
  const screenshot = async (state: string) => {
    for (const width of [1440, 390]) {
      window.setContentSize(width, 900)
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await wait(`window.innerWidth === ${width}`)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await delay(150)
        assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${state} has no page overflow`)
        if (state === 'detail') {
          const geometry = await execute(`(() => { const el=document.querySelector('.coordination-panel'), rect=el.getBoundingClientRect(); return {x:rect.x,width:rect.width,right:rect.right,viewport:innerWidth,root:document.querySelector('.project-workbench').className,body:document.querySelector('.workbench-body').getBoundingClientRect().width,css:getComputedStyle(el).width}; })()`)
          assert.ok(geometry.width >= 300 && geometry.x >= 0 && geometry.right <= geometry.viewport + 1, JSON.stringify(geometry))
        }
        if (process.env.WORK_SCREENSHOTS) await writeFile(join(process.env.WORK_SCREENSHOTS,
          `workbench-${state}-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(1440, 900)
    await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  }
  const question = '[data-request-id="fixture-decision"]'
  const input = '[data-request-id="fixture-input"]'
  const advance = () => execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({advance:true}) }).then(() => window.invalidateWork())`)
  try {
    const loading = window.loadURL(new URL('__work', process.env.WORK_SMOKE_URL).href)
    await window.webContents.debugger.sendCommand('Runtime.enable')
    await loading
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait(`document.querySelector('${question} .yield-prompt') && document.querySelector('${input} textarea')`)
    assert.equal(await execute(`document.querySelector('${question}').closest('[data-work-key]').dataset.workKey === window.fixtureKeys.root`), true)
    assert.equal(await execute(`document.querySelector('${question} .technical-origin').open`), false)
    assert.match(await execute(`document.querySelector('${question} .path-warning').innerText`), /not yet reassessed.*Prepare a grader/)
    assert.equal(await execute(`!!document.querySelector('[data-work-key="' + window.fixtureKeys.grader + '"]')`), false)
    await execute(`document.querySelector('${question} .technical-origin').open = true`)
    assert.match(await execute(`document.querySelector('${question} .technical-origin').textContent`), /Scored evaluation was assumed to be necessary/)
    await execute(`document.querySelector('${question} .technical-origin').open = false`)
    assert.match(await execute('document.querySelector(".project-activity").textContent'), /Untracked conversation/)
    assert.match(await execute('document.querySelector(".project-activity .child-activity").textContent'), /Inspect inputs.*Delegated by.*Untracked conversation/)
    assert.equal(await execute('!!document.querySelector(".note-editor")'), false)
    assert.equal(await execute('[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="Edit note")'), false)
    await click('Discuss this premise', '.context-node.root')
    assert.match(await execute('document.querySelector("#fixture-composer").value'), /Keep my unsent draft[\s\S]*Discuss the premise/)
    await execute(`document.querySelector('${question} input[type=radio]').dispatchEvent(new KeyboardEvent('keydown', { key:'a', bubbles:true, cancelable:true }))`)
    assert.equal(await execute(`document.querySelector('${question} input:checked').value`), 'Wait for a grader')
    await execute(`document.querySelector('${question} .yield-custom-toggle').click()`)
    await wait(`document.querySelector('${question} .yield-custom textarea')`)
    await fill(`${question} .yield-custom textarea`, 'Compare token usage; a grader is not required.')
    await execute(`window.answerDraft = document.querySelector('${question} .yield-custom textarea')`)
    await advance()
    await wait('document.querySelector(".context-canvas").textContent.includes("Usage report is ready")')
    assert.equal(await execute(`window.answerDraft === document.querySelector('${question} .yield-custom textarea')`), true)
    assert.equal(await execute('window.answerDraft.value'), 'Compare token usage; a grader is not required.')
    assert.equal(await execute('document.activeElement === window.answerDraft'), true, 'Routine updates do not steal focus')
    assert.equal(await execute(`!!document.querySelector('[data-work-key="' + window.fixtureKeys.grader + '"]')`), false)
    await screenshot('overview')

    const goal = `[data-work-key="${await execute('window.fixtureKeys.root')}"]`
    await click('Inspect notes', goal)
    await execute(`document.querySelector('${goal} .work-exhibit').open = true`)
    await wait(`document.querySelector('${goal} iframe')`)
    assert.equal(await execute(`document.querySelector('${goal} iframe').getAttribute('sandbox')`), '')
    let frame = window.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    const frameDeadline = Date.now() + 10000
    while (!frame && Date.now() < frameDeadline) { await delay(30); frame = window.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc') }
    assert.ok(frame, 'The HTML exhibit has a separate frame')
    await assert.rejects(frame.executeJavaScript('window.__exhibitScriptRan = true'), error => String(error).includes('Script not run'))
    assert.equal(await execute(`document.querySelector('${goal} iframe').contentDocument === null`), true)
    const targets: { targetInfos: { type: string; url: string; targetId: string }[] } = await window.webContents.debugger.sendCommand('Target.getTargets')
    const target = targets.targetInfos.find(target => target.type === 'iframe' && target.url === 'about:srcdoc')
    assert.ok(target)
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
    assert.notEqual(colors[0], colors[1])
    assert.equal(await execute('window.__exhibitEscaped'), undefined)
    await execute(`document.querySelector('${goal} .work-exhibit').open = false`)
    await click('Less detail', goal)
    await execute(`document.querySelector('${question} form').requestSubmit()`)
    await wait(`!document.querySelector('${question}')`)

    // Exercise the current workbench's real Discuss -> compose event, not an obsolete note editor.
    await click('Evaluate release candidates', '.node-heading')
    await wait('document.querySelector(".project-work-detail .work-alignment")?.innerText.includes("Compare release candidates")')
    assert.match(await execute('document.querySelector(".work-alignment").innerText'), /Working interpretation/)
    assert.equal(await execute('!!document.querySelector(".note-editor")'), false)
    assert.equal(await execute('[...document.querySelectorAll(".work-alignment button")].some(button=>button.textContent.trim()==="Edit note")'), false)
    await click('Discuss in a new chat', '.coordination-panel-heading')
    assert.match(await execute('document.querySelector("#fixture-composer").value'), /Keep my unsent draft[\s\S]*\/projects\/p\/dashboard\?work=topic%3Aweb%3Afixture/)
    assert.match(await execute('document.querySelector("#fixture-composer").value'), /Work reference only; no assignment or notification/)
    assert.equal(await execute('window.fixture.navigated'), '', 'Discussion must not open the assignee conversation')
    assert.equal(await execute('document.querySelectorAll(".project-work-detail .person-row").length'), 2)
    assert.equal(await execute('document.querySelectorAll(".project-work-detail .person-row select, .project-work-detail .decision-owner, .reporting-settings, .session-link").length'), 0)
    assert.equal(await execute('document.querySelectorAll(".technical-details dt").length'), 1, 'Technical details does not repeat either role')
    await screenshot('detail')

    // The remaining impact assessment keeps optimistic concurrency and draft retention.
    await fill('.work-alignment form textarea', 'Token metrics can continue without a grader')
    await advance()
    await wait('document.querySelector(".work-alignment").textContent.includes("The branch changed")')
    assert.equal(await execute('document.querySelector(".work-alignment form textarea").value'), 'Token metrics can continue without a grader')
    await click('Record assessment', '.work-alignment')
    await wait(`document.querySelector('.work-alignment [role="alert"]')?.textContent.includes('note changed')`)
    assert.equal(await execute('document.querySelector(".work-alignment form textarea").value'), 'Token metrics can continue without a grader')
    await click('Assess this version', '.work-alignment')
    await click('Record assessment', '.work-alignment')
    await wait('!document.querySelector(".work-alignment form")')
    assert.match(await execute('document.querySelector(".work-alignment").textContent'), /Token metrics can continue without a grader/)

    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({unavailable:true}) }).then(() => window.invalidateWork())`)
    await wait('document.querySelector(".workbench-error")')
    assert.match(await execute('document.querySelector(".workbench-error").textContent'), /Showing the last loaded state/)
    assert.match(await execute('document.querySelector(".work-alignment h3").textContent'), /Evaluate release candidates/)
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({unavailable:false}) }).then(() => window.invalidateWork())`)
    await wait('!document.querySelector(".workbench-error")')

    await execute('window.fixture.mode="canvas"; window.setAdmin(false)')
    await wait(`document.querySelector('${input} fieldset')?.disabled`)
    await wait('document.querySelector(".work-alignment .alignment-heading")')
    assert.equal(await execute(`!!document.querySelector('${input} button[type=submit]')`), false)
    assert.equal(await execute('[...document.querySelectorAll(".context-canvas .node-actions button")].some(button=>button.textContent.includes("Discuss this premise"))'), false)
    assert.equal(await execute('!!document.querySelector(".work-alignment form, .work-alignment .person-row select, .note-editor")'), false)
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({unavailable:true}) }).then(() => window.invalidateWork())`)
    await wait('document.querySelector(".fixture-refresh-error")')
    assert.equal(await execute('document.querySelectorAll(".context-node").length'), 4, 'Failed refresh retains the last snapshot and collapsed branches')
    await execute(`fetch('/__fixture', { method:'POST',body:JSON.stringify({empty:true,unavailable:false}) }).then(() => window.invalidateWork())`)
    await wait('document.body.innerText.includes("There is no goal map yet")')
    assert.equal(await execute('!!document.querySelector(".fixture-refresh-error")'), false)
    assert.match(await execute('document.querySelector(".project-activity").textContent'), /Untracked conversation/)
    assert.match(await execute('document.querySelector(".unlinked-questions").textContent'), /Which report should be attached/)
    await execute('window.showProjectDelete()')
    await wait('document.querySelector(".project-delete-dialog")?.open')
    assert.equal(await execute('document.activeElement.textContent'), 'Cancel')
    assert.equal(await execute('document.querySelector(".delete-confirm").disabled'), true)
    await fill('.project-delete-dialog input', 'Release evidence')
    await wait('!document.querySelector(".delete-confirm").disabled')
    await click('Delete project')
    await wait('document.querySelector(".delete-error")?.textContent.includes("Stop active")')
    assert.equal(await execute('document.querySelector(".project-delete-dialog input").value'), 'Release evidence')
    await click('Delete project')
    await wait('window.fixture.deleted && !document.querySelector(".project-delete-dialog")')
    assert.deepEqual(failures, [], 'No uncaught renderer exceptions')
    console.log('WORK_SMOKE_OK')
  } finally { clearTimeout(watchdog); window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
