import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = async (code: string) => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (cause) { throw new Error(`Failed renderer expression: ${code}`, { cause }) }
  }
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
    await wait(`document.querySelectorAll('.tool-entry').length === 4`)
    assert.deepEqual(await execute(`[...document.querySelectorAll('.tool-entry .tool-icon')].map(icon =>
      [...icon.classList].find(name => name.startsWith('i-material-icon-theme-') || name.startsWith('i-lucide-')))`),
    ['i-material-icon-theme-json', 'i-lucide-wrench', 'i-material-icon-theme-python', 'i-lucide-file-pen-line'])
    assert.equal(await execute(`document.querySelectorAll('.tool-payload, .file-highlight-content').length`), 0, 'Collapsed tool groups mount no payload renderers')
    await click('.tool-activity-summary')
    await wait(`document.querySelector('.tool-activity').open`)
    assert.equal(await execute(`document.querySelectorAll('.tool-payload, .file-highlight-content').length`), 0, 'Opening the group does not highlight collapsed calls')
    await click('.tool-call-header')
    const colored = (selector: string) => `Array.from(document.querySelectorAll('${selector} .file-syntax-token')).some(token => token.style.getPropertyValue('--file-token-light'))`
    await wait(colored('.tool-call-detail'))
    await wait(colored('.tool-result-content'))
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
    await wait(`document.querySelector('.tool-result-content') && !document.querySelector('.tool-result-content .file-highlight-content')`)
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent`), 'Message sent.\r\n<script>not executable</script>')
    await execute(`window.showToolImage()`)
    await wait(`document.querySelector('.tool-result-content img')?.naturalWidth === 2`)
    assert.equal(await execute(`document.querySelector('.tool-result-content img').alt`), 'Tool output image 1')
    assert.equal(await execute(`document.querySelector('.tool-result-content pre').textContent.includes('base64,')`), false)
    await click('.tool-call-header')
    await wait(`!document.querySelector('.tool-entry-content')`)
    await execute(`document.querySelectorAll('.tool-call-header')[1].click()`)
    await wait(`document.querySelector('.tool-result-content')?.textContent === '(Empty result)'`)
    window.setContentSize(1200, 1100)

    await window.loadURL(`${process.env.TRACE_SMOKE_URL}/__trace`)
    await wait(`document.querySelectorAll('.lane-bar').length === 3`)
    assert.match(await scale(), /355m 0s/)
    assert.match(await scale(), /360m 0s/)
    assert.equal(await execute(`document.querySelector('.timeline-pan input').value`), '100')
    assert.equal(await execute(`document.querySelectorAll('.lane-bar[title]').length`), 0)
    await execute(`[...document.querySelectorAll('.event-filters button')].find(b => b.textContent.trim() === 'session').click()`)
    await wait(`document.querySelectorAll('.trace-event').length === 1`)
    assert.equal(await execute(`document.querySelector('.event-kind.SESSION').textContent`), 'SESSION')
    assert.match(await execute(`document.querySelector('.trace-event-header').textContent`), /Session handoff.*web:orchestrator.*Delegated inspection/s)
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
    await wait(`document.querySelector('.span-inspector .payload-image img')?.naturalWidth === 2`)
    assert.equal(await execute(`document.querySelector('.span-inspector').innerText.includes('base64,')`), false)
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
    assert.equal(JSON.parse(await execute(`Array.from(document.querySelectorAll('.span-inspector h4')).find(heading => heading.textContent === 'Returned tool calls').nextElementSibling.textContent`))[0].id, 'call-1')
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
