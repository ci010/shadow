import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code).catch(cause => {
    throw new Error(`Renderer script failed: ${code}`, { cause })
  })
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = (selector: string) => execute(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const scale = () => execute(`document.querySelector('.timeline-scale').innerText`)
  const inspector = () => execute(`document.querySelector('.span-inspector')?.innerText`)
  const pan = (value: number) => execute(`(() => { const input = document.querySelector('.timeline-pan input'); input.value = ${value}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const button = (label: string) => `button[aria-label="${label}"]`
  try {
    await window.loadURL(`${process.env.TRACE_SMOKE_URL}/__context`)
    await wait(`!!document.querySelector('#diagnosis-prompt-tab')`)
    await click('#diagnosis-prompt-tab')
    await wait(`document.querySelector('#diagnosis-prompt-tab').getAttribute('aria-selected') === 'true'`)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await delay(100)
      const layout = await execute(`(() => {
        const content = document.querySelector('#diagnosis-prompt .system-prompt-content');
        const card = content.parentElement.parentElement;
        const header = card.firstElementChild;
        const copy = header.querySelector('button');
        const body = content.parentElement.getBoundingClientRect();
        const top = header.getBoundingClientRect();
        const button = copy.getBoundingClientRect();
        return { direction: getComputedStyle(card).flexDirection, display: getComputedStyle(card).display,
          stacked: body.top >= top.bottom - 1, bodyWidth: body.width, cardWidth: card.getBoundingClientRect().width,
          copyFits: button.height < 50 && button.top >= top.top && button.bottom <= top.bottom + 1,
          noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          copyText: copy.textContent.trim(), cards: document.querySelectorAll('#diagnosis-prompt .system-prompt-content').length };
      })()`)
      assert.equal(layout.display, 'flex')
      assert.equal(layout.direction, 'column', 'System prompt header and body must stack vertically on the first stylesheet load')
      assert.equal(layout.stacked, true)
      assert.ok(layout.bodyWidth >= layout.cardWidth - 4, 'Prompt uses the full card width instead of a narrow side column')
      assert.equal(layout.copyFits, true, 'Copy button stays in the header, not a full-height strip')
      assert.equal(layout.copyText, 'Copy')
      assert.equal(layout.cards, 2, 'Compaction summary remains a separate card')
      assert.equal(layout.noOverflow, true)
    }
    await execute(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedPrompt = text; } } })`)
    await click('#diagnosis-prompt .copy-btn')
    await wait(`document.querySelector('#diagnosis-prompt .copy-btn').textContent.includes('Copied!')`)
    assert.match(await execute('window.copiedPrompt'), /^# Project coordinator/)
    await click('#diagnosis-tools-tab')
    assert.equal(await execute(`getComputedStyle(document.querySelector('#diagnosis-tools > div')).flexDirection`), 'column')
    assert.equal(await execute(`document.querySelector('#diagnosis-tools .tool-def-name').textContent`), 'read')
    window.setContentSize(1200, 1100)
    await window.loadURL(`${process.env.TRACE_SMOKE_URL}/__tool-details`)
    await wait(`document.querySelectorAll('.tool-entry').length === 6`)
    assert.deepEqual(await execute(`[...document.querySelectorAll('.tool-entry .tool-icon')].map(icon =>
      [...icon.classList].find(name => name.startsWith('i-material-icon-theme-') || name.startsWith('i-lucide-')))`),
    ['i-material-icon-theme-json', 'i-lucide-wrench', 'i-material-icon-theme-python', 'i-lucide-file-pen-line', 'i-material-icon-theme-typescript', 'i-lucide-search'])
    assert.equal(await execute(`document.querySelectorAll('.tool-payload, .file-highlight-content').length`), 0, 'Collapsed tool groups mount no payload renderers')
    await click('.tool-activity-summary')
    await wait(`document.querySelector('.tool-activity').open`)
    await wait(`document.querySelector('.tool-activity').getAnimations().length > 0`)
    assert.equal(await execute(`document.querySelector('.activity-chevron').getAnimations().some(a => a.transitionProperty === 'transform')`), true, 'Chevron rotates rather than swapping icons')
    await wait(`document.querySelector('.tool-activity').getAnimations().length === 0`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('DOM.enable')
    await window.webContents.debugger.sendCommand('CSS.enable')
    const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.tool-call-header' })
    const iconState = () => execute(`(() => {
      const row = document.querySelector('.tool-call-header');
      const slot = row.querySelector('.tool-disclosure-icon').getBoundingClientRect();
      const icon = getComputedStyle(row.querySelector('.tool-icon'));
      const arrow = getComputedStyle(row.querySelector('.activity-chevron'));
      return { icon: icon.opacity, arrow: arrow.opacity, rotation: arrow.transform,
        width: slot.width, gap: row.querySelector('.tool-name').getBoundingClientRect().left - slot.right,
        directIcons: row.querySelectorAll(':scope > .tool-icon, :scope > .activity-chevron').length };
    })()`)
    const restingIcon = await iconState()
    assert.equal(restingIcon.icon, '1')
    assert.equal(restingIcon.arrow, '0')
    assert.equal(restingIcon.width, 16)
    assert.equal(restingIcon.gap, 8)
    assert.equal(restingIcon.directIcons, 0, 'Both graphics share one slot rather than two layout items')
    for (const hovering of [true, false]) {
      await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: hovering ? ['hover'] : [] })
      await wait(`document.querySelector('.tool-call-header').getAnimations().some(a => a.transitionProperty === 'background-color')`)
      await wait(`document.querySelector('.tool-disclosure-icon .activity-chevron').getAnimations().some(a => a.transitionProperty === 'opacity')`)
      await wait(`document.querySelector('.tool-call-header').getAnimations().length === 0`)
      await wait(`document.querySelector('.tool-disclosure-icon').getAnimations({subtree:true}).length === 0`)
      const state = await iconState()
      assert.equal(state.icon, hovering ? '0' : '1')
      assert.equal(state.arrow, hovering ? '1' : '0')
      assert.equal(state.gap, restingIcon.gap, 'Icon swapping must not move the tool label')
    }
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] })
    await wait(`getComputedStyle(document.querySelector('.tool-disclosure-icon .activity-chevron')).opacity === '1'`)
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    window.webContents.debugger.detach()
    assert.equal(await execute(`document.querySelectorAll('.tool-payload, .file-highlight-content').length`), 0, 'Opening the group does not highlight collapsed calls')
    await click('.tool-call-header')
    const colored = (selector: string) => `Array.from(document.querySelectorAll('${selector} .file-syntax-token')).some(token => token.style.getPropertyValue('--file-token-light'))`
    await wait(colored('.tool-call-detail'))
    await wait(colored('.tool-result-content'))
    await wait(`document.querySelector('.tool-disclosure-icon').getAnimations({subtree:true}).length === 0`)
    assert.equal((await iconState()).icon, '0')
    assert.equal((await iconState()).arrow, '1', 'Expanded calls retain the chevron without hover')
    assert.equal((await iconState()).rotation, 'matrix(0, 1, -1, 0, 0, 0)', 'Expanded chevron points down')
    assert.equal(await execute(`document.querySelectorAll('.tool-entry')[1].querySelectorAll('.tool-payload').length`), 0)
    assert.equal(await execute(`document.querySelector('.tool-call-detail pre').textContent`), '{\n  "path": "fixture.json",\n  "count": 42\n}')
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent`), '{"ok":true,"html":"<img src=x onerror=alert(1)>"}')
    assert.equal(await execute(`document.querySelectorAll('.tool-result-content img').length`), 0, 'Highlighted data is escaped text, never HTML')
    const lightColor = await execute(`getComputedStyle(document.querySelector('.tool-call-detail .file-syntax-token[style]')).color`)
    await execute(`document.documentElement.classList.add('dark')`)
    assert.notEqual(await execute(`getComputedStyle(document.querySelector('.tool-call-detail .file-syntax-token[style]')).color`), lightColor, 'Tokens follow the active theme')
    window.setContentSize(390, 844)
    assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
    await click('.tool-result-header')
    await wait(`!document.querySelector('.tool-result-content')`)
    await execute(`window.updateToolResult('{"latest":42}')`)
    assert.equal(await execute(`document.querySelectorAll('.tool-result-content').length`), 0, 'Result updates do not render while its disclosure is closed')
    await click('.tool-result-header')
    await wait(colored('.tool-result-content'))
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent`), '{"latest":42}')
    await click('.tool-activity-summary')
    await wait(`!document.querySelector('.file-highlight-content')`)
    await execute(`window.updateToolResult('{"afterReopen":true}')`)
    await click('.tool-activity-summary')
    await wait(colored('.tool-result-content'))
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent`), '{"afterReopen":true}', 'Group reopen preserves entry expansion and uses current content')
    await execute(`window.updateToolResult(undefined)`)
    await wait(`!document.querySelector('.tool-result')`)
    await execute(`window.updateToolResult('{"arrived":true}')`)
    await wait(colored('.tool-result-content'))
    await execute(`window.updateToolResult('Message sent.\\r\\n<script>not executable</script>')`)
    await wait(`document.querySelector('.tool-result-content pre')?.textContent === 'Message sent.\\r\\n<script>not executable</script>'`)
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent`), 'Message sent.\r\n<script>not executable</script>')
    await click('.tool-call-header')
    await wait(`!document.querySelector('.tool-entry-content')`)
    await execute(`document.querySelectorAll('.tool-call-header')[1].click()`)
    await wait(`document.querySelector('.tool-result-content')?.textContent === '(Empty result)'`)
    await execute(`document.querySelectorAll('.tool-call-header')[1].click(); document.querySelectorAll('.tool-call-header')[4].click()`)
    await wait(colored('.tool-entry:nth-of-type(5) .tool-result-content'))
    assert.ok(await execute(`new Set([...document.querySelectorAll('.tool-entry:nth-of-type(5) .tool-result-content .file-syntax-token')].map(t => t.style.getPropertyValue('--file-token-light')).filter(Boolean)).size > 1`), 'Imported view calls highlight TypeScript output, not just argument JSON')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.tool-entry:nth-of-type(5) .tool-result-content .payload-source')).whiteSpace`), 'pre')
    assert.equal(await execute(`(() => { const p = document.querySelector('.tool-entry:nth-of-type(5) .tool-result-content'); return p.scrollWidth > p.clientWidth; })()`), true, 'Long read lines scroll horizontally instead of wrapping')
    await execute(`document.querySelectorAll('.tool-call-header')[5].click()`)
    await wait(colored('.search-code'))
    assert.deepEqual(await execute(`[...document.querySelectorAll('.search-line-number')].map(e => e.dataset.line)`), ['158', '159'])
    assert.equal(await execute(`document.querySelector('.search-code').textContent`), '    for (const [file, checksum] of Object.entries(proc.outputs)) {')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.search-code')).whiteSpace`), 'pre')
    assert.equal(await execute(`document.querySelector('.search-code').getBoundingClientRect().height`), 22, 'Line 158 is exactly one visual line')
    assert.equal(await execute(`(() => { const p = document.querySelector('.search-lines'); return p.scrollWidth > p.clientWidth; })()`), true)
    assert.equal(await execute(`document.querySelectorAll('.search-code script').length`), 0)
    assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
    if (process.env.TOOL_ACTIVITY_SCREENSHOTS) {
      await wait(`document.getAnimations().length === 0`)
      for (const width of [390, 1200]) {
        window.setContentSize(width, 1100)
        for (const dark of [false, true]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('.search-results').scrollIntoView({ block: 'end' })`)
          await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          await writeFile(join(process.env.TOOL_ACTIVITY_SCREENSHOTS, `tool-activity-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
        }
      }
      window.setContentSize(390, 844)
    }
    await wait(`document.querySelector('.tool-activity').getAnimations().length === 0`)
    await click('.tool-activity-summary')
    await wait(`document.querySelector('.tool-activity').getAnimations().length > 0`)
    assert.equal(await execute(`document.querySelector('.tool-activity').open`), true, 'Native content remains mounted during exit')
    await click('.tool-activity-summary')
    await wait(`document.querySelector('.tool-activity').getAnimations().length === 0 && document.querySelector('.tool-activity').dataset.expanded === 'true'`)
    assert.equal(await execute(`document.querySelector('.tool-activity').open && !!document.querySelector('.search-results')`), true, 'Interrupted collapse returns to expanded state')
    await window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click('.tool-activity-summary')
    await wait(`!document.querySelector('.tool-activity').open`)
    assert.equal(await execute(`document.querySelector('.tool-activity').getAnimations().length`), 0)
    await execute(`document.querySelector('.tool-activity-summary').focus()`)
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait(`document.querySelector('.tool-activity').open && !!document.querySelector('.search-results')`)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.activity-chevron')).transitionDuration`), '0s')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.tool-call-header')).transitionDuration`), '0s')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.tool-disclosure-icon .tool-icon')).transitionDuration`), '0s')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.tool-disclosure-icon .activity-chevron')).transitionDuration`), '0s')
    await execute(`document.querySelector('.tool-call-header').focus()`)
    for (const open of [true, false]) {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait(`document.querySelector('.tool-entry').open === ${open}`)
      assert.equal((await iconState()).arrow, '1', 'Keyboard focus exposes the disclosure in both states')
    }
    await execute(`document.querySelector('.tool-call-header').blur()`)
    await wait(`getComputedStyle(document.querySelector('.tool-disclosure-icon .tool-icon')).opacity === '1'`)
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    window.webContents.debugger.detach()
    window.setContentSize(1200, 1100)

    assert.equal(await execute(`document.querySelector('.execution-inspect').getAttribute('aria-pressed')`), 'true')
    assert.equal(await execute(`document.querySelector('.execution-card').classList.contains('execution-selected')`), true)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.execution-inspect')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'Selection does not fill an inset header rectangle')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.execution-card .message-preview-content')).minHeight`), '0px')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.execution-details > summary')).paddingLeft`), '0px')
    assert.equal(await execute(`document.querySelectorAll('.execution-details .tool-payload').length`), 0)
    await click('.execution-details > summary')
    await wait(colored('.execution-arguments'))
    await wait(colored('.execution-result'))
    assert.equal(await execute(`window.executionInspections`), 0, 'Tool details do not navigate to the child session')
    assert.equal(await execute(`document.querySelectorAll('.execution-details .payload-box').length`), 2)
    assert.equal(await execute(`document.querySelectorAll('.execution-details img').length`), 0)
    assert.equal(await execute(`document.querySelector('.execution-result pre').textContent`), '{"status":"running","message":"Task started."}')
    for (const width of [390, 1200]) {
      window.setContentSize(width, 1100)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        const boxes = await execute(`['.tool-call-detail', '.tool-result-content', '.execution-arguments', '.execution-result'].map(selector => {
          const style = getComputedStyle(document.querySelector(selector));
          return ['backgroundColor', 'padding', 'fontFamily', 'fontSize', 'lineHeight', 'borderRadius', 'maxHeight', 'overflowWrap']
            .map(key => style[key]);
        })`)
        for (const box of boxes.slice(1)) assert.deepEqual(box, boxes[0], 'All tool payload boxes share the same styling')
        assert.equal(boxes[0][1], '10px 12px')
        assert.equal(boxes[0][3], '12px')
        assert.equal(boxes[0][6], '300px')
        assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
      }
    }
    await execute(`window.updateExecutionReceipt(undefined)`)
    await wait(`!document.querySelector('.execution-result')`)
    await execute(`window.updateExecutionReceipt('')`)
    await wait(`document.querySelector('.execution-result pre')?.textContent === '(Empty result)'`)
    await execute(`window.updateExecutionReceipt('Error: synthetic failure')`)
    await wait(`document.querySelector('.execution-result pre')?.textContent === 'Error: synthetic failure'`)
    await click('.execution-details > summary')
    await wait(`!document.querySelector('.execution-details .tool-payload')`)
    await click('.execution-details > summary')
    await wait(`document.querySelector('.execution-result pre')?.textContent === 'Error: synthetic failure'`)

    await window.loadURL(`${process.env.TRACE_SMOKE_URL}/__trace`)
    await wait(`document.querySelectorAll('.lane-bar').length === 3`)
    assert.match(await scale(), /355m 0s/)
    assert.match(await scale(), /360m 0s/)
    assert.equal(await execute(`document.querySelector('.timeline-pan input').value`), '100')
    assert.equal(await execute(`document.querySelectorAll('.lane-bar[title]').length`), 0)
    assert.equal(await execute(`document.querySelectorAll('.event-batch').length`), 0)
    assert.equal(await execute(`document.querySelector('.event-kind.TOOL').closest('.trace-event').dataset.batchId`), 'segment:message-3')
    assert.match(await execute(`document.querySelector('.event-kind.TOOL').closest('.trace-event').querySelector('.trace-event-header').title`), /Batch 2 · 1 items.*one LLM call/)
    assert.equal(await execute(`document.querySelector('.event-kind.TOOL').closest('.trace-event').classList.contains('batch-color-1')`), true)
    assert.equal(await execute(`[...document.querySelectorAll('.event-kind.USER, .event-kind.SESSION')].every(n => !n.closest('.trace-event').querySelector('.event-batch-indicator'))`), true)
    assert.equal(await execute(`[...document.querySelectorAll('.trace-event-header[aria-describedby]')].every(n => document.getElementById(n.getAttribute('aria-describedby')).textContent === n.title)`), true)
    assert.equal(await execute(`[...document.querySelectorAll('.event-batch-indicator')].every(n => n.getAttribute('aria-hidden') === 'true')`), true)
    const batchLightColor = await execute(`getComputedStyle(document.querySelector('.batch-color-1 .event-batch-indicator')).backgroundColor`)
    await execute(`document.documentElement.classList.add('dark')`)
    assert.notEqual(await execute(`getComputedStyle(document.querySelector('.batch-color-1 .event-batch-indicator')).backgroundColor`), batchLightColor)
    await execute(`document.documentElement.classList.remove('dark')`)
    await execute(`[...document.querySelectorAll('.event-filters button')].find(b => b.textContent.trim() === 'tool').click()`)
    await wait(`document.querySelectorAll('.trace-event').length === 1`)
    assert.equal(await execute(`document.querySelector('.trace-event').classList.contains('batch-color-1')`), true)
    await execute(`[...document.querySelectorAll('.event-filters button')].find(b => b.textContent.trim() === 'session').click()`)
    await wait(`document.querySelectorAll('.trace-event').length === 1`)
    assert.equal(await execute(`document.querySelector('.event-kind.SESSION').textContent`), 'SESSION')
    assert.match(await execute(`document.querySelector('.trace-event-header').textContent`), /Received handoff.*web:orchestrator.*Delegated inspection/s)
    assert.doesNotMatch(await execute(`document.querySelector('.event-preview').textContent`), /<sender/)
    await click('.trace-event-header')
    assert.match(await execute(`document.querySelector('.trace-event-detail').textContent`), /protocol role, not a human author/)
    assert.match(await execute(`document.querySelector('.trace-event-detail details pre').textContent`), /<sender id="web:orchestrator"/)
    await execute(`[...document.querySelectorAll('.event-filters button')].find(b => b.textContent.trim() === 'user').click()`)
    await wait(`document.querySelectorAll('.trace-event').length === 2`)
    assert.equal(await execute(`document.querySelectorAll('.event-kind.SESSION').length`), 0)
    await execute(`[...document.querySelectorAll('.event-filters button')].find(b => b.textContent.trim() === 'All events').click()`)

    await click('.lane-bar.input')
    await wait(`!!document.querySelector('.span-inspector .trace-event-content')`)
    assert.match(await inspector(), /Recent input with complete event content/)
    assert.equal(await execute(`document.querySelector('.lane-bar.input').getAttribute('aria-pressed')`), 'true')
    const scroll = await execute(`document.querySelector('.diagnosis-scroll').scrollTop`)
    await click('.lane-bar.tools')
    await wait(`document.querySelector('.span-inspector')?.innerText.includes('Tool call JSON')`)
    assert.equal(await execute(`document.querySelector('.diagnosis-scroll').scrollTop`), scroll, 'Selection does not jump to event list')
    const call = JSON.parse(await execute(`document.querySelector('.span-inspector .trace-event-content pre').textContent`))
    assert.equal(call.id, 'call-1')
    assert.equal(JSON.parse(call.function.arguments).nested.value, 42)
    assert.match(await inspector(), /Synthetic tool result/)
    await wait(colored('.span-inspector .trace-payload'))

    await execute(`document.querySelector('.lane-bar.tools').parentElement.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))`)
    await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('Synthetic metadata')`)
    assert.equal(await execute(`document.querySelector('[role="tooltip"]').parentElement === document.body`), true)
    assert.equal(await execute(`document.querySelector('.lane-bar.tools').getAttribute('aria-describedby') === document.querySelector('[role="tooltip"]').id`), true)
    assert.match(await execute(`document.querySelector('[role="tooltip"]').innerText`), /10.00 s/)
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await wait(`!document.querySelector('[role="tooltip"]')`)

    await click('.lane-bar.model')
    assert.match(await inspector(), /Final model return/)
    assert.match(await inspector(), /Returned tool calls/)
    assert.equal(JSON.parse(await execute(`document.querySelector('.span-inspector .trace-event-content > pre').textContent`))[0].id, 'call-1')
    await execute(`document.querySelector('.span-inspector .trace-event-content details').open = true`)
    assert.match(await inspector(), /Synthetic model reasoning/)
    for (const state of ['live', 'failed', 'recorded']) {
      await fetch(`${process.env.TRACE_SMOKE_URL}/__trace/model-${state}`)
      await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh').click()`)
      const text = state === 'live' ? 'Waiting for this model call' : state === 'failed' ? 'failed before returning' : 'Final model return'
      await wait(`document.querySelector('.span-inspector')?.innerText.includes(${JSON.stringify(text)})`)
    }
    await pan(50)
    await wait(`document.querySelector('.trace-timeline').textContent.includes('No recorded activity in this window')`)
    const manual = await scale()
    await fetch(`${process.env.TRACE_SMOKE_URL}/__trace/advance`)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh').click()`)
    await wait(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh' && !b.disabled)`)
    assert.equal(await scale(), manual, 'Refresh preserves manually positioned window')

    await pan(0)
    await wait(`document.querySelectorAll('.lane-bar').length === 2`)
    await click('.lane-bar.input')
    assert.match(await inspector(), /Old input/)
    await click('.lane-bar.model')
    assert.match(await inspector(), /Historical model return/)
    assert.match(await inspector(), /Historical response matched/)
    assert.equal(await execute(`document.querySelector(${JSON.stringify(button('Previous time window'))}).disabled`), true)
    await click(button('Next time window'))
    assert.match(await scale(), /5m 0s/)
    await click(button('Previous time window'))
    assert.match(await scale(), /0 ms/)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Latest 5 min').click()`)
    assert.match(await scale(), /356m 0s/)
    assert.match(await scale(), /361m 0s/)

    await click(button('Zoom into trace'))
    assert.match(await scale(), /357m 15s/)
    await click(button('Zoom out of trace'))
    assert.match(await scale(), /356m 0s/)
    for (let i = 0; i < 7; i++) await click(button('Zoom out of trace'))
    assert.equal(await execute(`!!document.querySelector('.timeline-pan')`), false)
    assert.match(await scale(), /0 ms/)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Latest 5 min').click()`)

    window.setContentSize(390, 844)
    await delay(100)
    assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'Mobile layout has no horizontal page overflow')
    assert.equal(await execute(`document.querySelector('.trace-timeline').scrollWidth <= document.querySelector('.trace-timeline').clientWidth`), true, 'Mobile timeline controls fit')
    await click('.lane-bar.tools')
    assert.match(await inspector(), /Tool call JSON/)
    await click('.lane-bar.model')
    assert.match(await inspector(), /Final model return/)
    const download = new Promise<string>(resolve => {
      window.webContents.session.once('will-download', (event, item) => {
        event.preventDefault()
        resolve(item.getFilename())
      })
    })
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export for agent').click()`)
    await wait(`document.body.innerText.includes('Exported a partial snapshot')`)
    assert.equal(await Promise.race([download, delay(5000).then(() => 'download-timeout')]), 'diagnosis-segment.json')
    console.log('TRACE_RENDERED_SMOKE_OK')
  } finally {
    window.destroy()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
