import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  await window.webContents.session.setProxy({ mode: 'direct' })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(40) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${await execute('JSON.stringify(window.__agentFixture.requests)')}`)
  }
  const frame = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The fixture renderer did not produce a frame.')), 12_000) }),
      ])
    } finally { clearTimeout(timer) }
  }
  const input = async (selector: string, value: string) => {
    await execute(`{ const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); }`)
    await frame()
  }
  const tab = async (view: 'overview' | 'tools' | 'prompt') => {
    await execute(`document.querySelector('[role="tab"][id$="-${view}-tab"]').click()`)
    await wait(`document.querySelector('[role="tab"][id$="-${view}-tab"]').getAttribute('aria-selected') === 'true'`)
    await frame()
  }
  const select = async (name: string) => {
    await execute(`Array.from(document.querySelectorAll('[data-agent-name]')).find(button => button.dataset.agentName === ${JSON.stringify(name)}).click()`)
    await wait(`document.querySelector('.agent-heading h2').textContent === ${JSON.stringify(name)}`)
    await frame()
  }
  const screenshot = async (name: string) => {
    if (!process.env.AGENT_BROWSER_SCREENSHOTS) return
    await frame()
    const image = await window.webContents.capturePage()
    await writeFile(join(process.env.AGENT_BROWSER_SCREENSHOTS, name + '.png'), image.toPNG())
  }
  const layout = () => execute(`(() => {
    const browser = document.querySelector('.agent-browser');
    const detail = document.querySelector('.agent-detail');
    return {overflow:browser.scrollWidth > browser.clientWidth || detail.scrollWidth > detail.clientWidth,
      documentOverflow:document.documentElement.scrollWidth > innerWidth,
      list:document.querySelector('.agent-navigation').getClientRects().length > 0,
      detail:detail.getClientRects().length > 0};
  })()`)
  try {
    await window.loadURL(new URL('__agent-browser', process.env.AGENT_BROWSER_URL).href)
    await wait(`document.querySelector('.tab-count')?.textContent === '3'`)
    assert.equal(await execute(`document.querySelector('[aria-label="Preview channel"]') !== null`), false)
    assert.equal(await execute(`document.querySelector('.tool-def') !== null`), false, 'Overview does not mount a wall of tools')
    assert.equal(await execute(`document.querySelector('.system-prompt-content') !== null`), false)
    assert.equal(await execute(`document.body.innerText.includes('Can Spawn') || document.body.innerText.includes('Prompt Includes')`), false)
    assert.deepEqual(await layout(), { overflow: false, documentOverflow: false, list: true, detail: true })
    assert.equal(await execute(`window.__agentFixture.router.currentRoute.value.query.retained`), 'yes')
    await input('[aria-label="Search agent types"]', 'Workspace-specific')
    assert.equal(await execute(`document.querySelectorAll('[data-agent-name]').length`), 1)
    await input('[aria-label="Search agent types"]', 'no matching fixture')
    assert.equal(await execute(`document.querySelector('.agent-list [role="status"]').textContent`), 'No matching agent types.')
    await input('[aria-label="Search agent types"]', '')
    await select('review')
    assert.match(await execute(`document.querySelector('.agent-overview').innerText`), /fixture-model@provider/)
    assert.match(await execute(`document.querySelector('.agent-overview').innerText`), /Temperature\s+0/)
    await select('general')
    await wait(`document.querySelector('.tab-count')?.textContent === '3'`)

    await execute(`{ const overview = document.querySelector('[role="tab"][id$="-overview-tab"]'); overview.focus(); overview.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true,cancelable:true})); }`)
    await wait(`document.querySelector('[role="tab"][id$="-tools-tab"]').getAttribute('aria-selected') === 'true'`)
    assert.equal(await execute(`document.activeElement === document.querySelector('[role="tab"][id$="-tools-tab"]')`), true)
    assert.equal(await execute(`document.querySelectorAll('[role="tab"][tabindex="0"]').length`), 1)
    await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true,cancelable:true}))`)
    await wait(`document.querySelector('[role="tab"][id$="-prompt-tab"]').getAttribute('aria-selected') === 'true'`)
    await wait(`!!document.querySelector('.system-prompt-content h1')`)
    assert.equal(await execute(`window.__unsafePrompt === undefined`), true)
    assert.equal(await execute(`document.querySelector('.system-prompt-content script') !== null`), false)
    await execute(`document.querySelector('.prompt-format button[aria-pressed="false"]').click()`)
    await wait(`!!document.querySelector('.system-prompt-raw')`)
    const raw = await execute(`document.querySelector('.system-prompt-raw').textContent`)
    assert.match(raw, /<available_skills>/)
    assert.match(raw, /<script>/)
    await wait(`!document.querySelector('.preview-copy').disabled`)
    await execute(`document.querySelector('.preview-copy').click()`)
    await wait(`!!document.querySelector('.copy-feedback')`)
    assert.equal(await execute(`window.__agentFixture.clipboard.writes.at(-1)`), raw)
    await tab('tools')
    await input('[aria-label="Search tools"]', 'path')
    assert.equal(await execute(`document.querySelectorAll('.tool-def').length`), 1)
    await execute(`document.querySelector('.tool-def summary').click()`)
    await wait(`document.querySelector('.tool-def').open`)
    assert.match(await execute(`document.querySelector('.tool-def-body').innerText`), /path\*/)
    assert.match(await execute(`document.querySelector('.tool-def-body').innerText`), /object \| null/)
    await execute(`document.querySelector('.preview-copy').click()`)
    await wait(`!!document.querySelector('.copy-feedback')`)
    const copiedTools = JSON.parse(await execute(`window.__agentFixture.clipboard.writes.at(-1)`))
    assert.equal(copiedTools.length, 3, 'Copy JSON includes all tools, not just search results')
    assert.equal(copiedTools[0].parameters.additionalProperties, false)
    await input('[aria-label="Search tools"]', 'no matching tools')
    assert.match(await execute(`document.querySelector('.tools-embedded').innerText`), /No matching tools/)
    await input('[aria-label="Search tools"]', '')
    await execute(`window.__agentFixture.clipboard.fail = true; document.querySelector('.preview-copy').click()`)
    await wait(`document.querySelector('.agent-error[role="alert"]')?.textContent.includes('Could not copy')`)
    assert.equal(await execute(`!!document.querySelector('.copy-feedback')`), false)
    await execute(`window.__agentFixture.clipboard.fail = false; window.__agentFixture.clipboard.hold = true; document.querySelector('.preview-copy').click()`)
    await wait(`document.querySelector('.preview-copy').disabled`)
    await tab('prompt')
    await execute(`window.__agentFixture.clipboard.hold = false; window.__agentFixture.clipboard.release()`)
    await frame()
    assert.equal(await execute(`!!document.querySelector('.copy-feedback')`), false, 'A late clipboard completion cannot mark a different view copied')

    await execute(`fetch('/__context/hold').then(() => {})`)
    await execute(`{ const channel = document.querySelector('[aria-label="Preview channel"]'); channel.value = 'discord'; channel.dispatchEvent(new Event('change',{bubbles:true})); }`)
    await wait(`!!document.querySelector('.previous-context') && document.querySelector('.preview-copy').disabled`)
    assert.match(await execute(`document.querySelector('.previous-context').textContent`), /general.*web/)
    await execute(`fetch('/__context/fail').then(() => {})`)
    await wait(`document.querySelector('.agent-error[role="alert"]')?.textContent.includes('503')`)
    await execute(`fetch('/__context/normal').then(() => {})`)
    await execute(`document.querySelector('.agent-error .text-action').click()`)
    await wait(`!document.querySelector('.previous-context') && !document.querySelector('.agent-error')`)
    assert.match(await execute(`document.querySelector('.system-prompt-raw').textContent`), /discord/)
    await execute(`fetch('/__context/invalid').then(() => {})`)
    await select('explore')
    await wait(`document.querySelector('.agent-error[role="alert"]')?.textContent.includes('Cannot read the assembled')`)
    assert.match(await execute(`document.querySelector('.previous-context').textContent`), /general.*discord/)
    await execute(`fetch('/__context/normal').then(() => {})`)
    await execute(`document.querySelector('.agent-error .text-action').click()`)
    await wait(`!document.querySelector('.previous-context') && !document.querySelector('.agent-error')`)
    await tab('tools')
    assert.equal(await execute(`document.querySelectorAll('.tool-def').length`), 2)
    await select('verify')
    await wait(`document.querySelector('.tools-embedded')?.innerText.includes('No tools available')`)
    assert.equal(await execute(`document.querySelector('.preview-copy').disabled`), true)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.tools-empty')).color === getComputedStyle(document.querySelector('.agent-note')).color`), true)
    await tab('overview')
    assert.match(await execute(`document.querySelector('.tool-policies').innerText`), /Allowlist\s+None listed/)
    assert.equal(await execute(`document.querySelector('.agent-overview').innerText.includes('No allowlist or blocklist declared')`), false)
    await tab('prompt')
    await wait(`document.querySelector('.prompt-empty')?.textContent.includes('No system prompt')`)
    assert.equal(await execute(`document.querySelector('.preview-copy').disabled`), true)
    await tab('tools')
    await select('general')
    await wait(`document.querySelectorAll('.tool-def').length === 3`)

    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await wait(`Math.abs(innerWidth - ${width}) <= 2`)
      await frame()
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await tab('overview')
        assert.deepEqual(await layout(), { overflow: false, documentOverflow: false, list: width === 1200, detail: true })
        await screenshot(`agents-${width}-${dark ? 'dark' : 'light'}-overview`)
        await tab('tools')
        assert.equal(await execute(`Array.from(document.querySelectorAll('.tool-def summary')).every(summary => summary.getBoundingClientRect().height >= 44)`), true)
        await screenshot(`agents-${width}-${dark ? 'dark' : 'light'}-tools`)
        await tab('prompt')
        await execute(`document.querySelector('.prompt-format button:first-child').click()`)
        await screenshot(`agents-${width}-${dark ? 'dark' : 'light'}-prompt`)
      }
      if (width === 390) {
        await execute(`document.querySelector('.agent-back').click()`)
        await wait(`document.querySelector('.agent-navigation').getClientRects().length > 0 && !document.querySelector('.agent-detail').getClientRects().length`)
        assert.equal(await execute(`document.activeElement.dataset.agentName`), 'general')
        const longName = await execute(`Array.from(document.querySelectorAll('[data-agent-name]')).find(button => button.dataset.agentName.length > 60).dataset.agentName`)
        await select(longName)
        assert.equal((await layout()).overflow, false)
        assert.equal(await execute(`document.querySelector('.agent-back').getBoundingClientRect().height >= 44`), true)
        await execute(`document.querySelector('.agent-back').click()`)
        await screenshot('agents-390-dark-types')
      }
    }
    window.setContentSize(1200, 844)
    await wait(`innerWidth > 700`)
    await execute(`window.__agentFixture.state.width = '600px'`)
    await frame()
    assert.equal((await layout()).list, true, 'A narrow pane uses list navigation even on a desktop viewport')
    assert.equal((await layout()).detail, false)
    await select('general')
    assert.equal((await layout()).list, false)
    assert.equal((await layout()).detail, true)
    await execute(`window.__agentFixture.state.project = 'broken'`)
    await wait(`document.querySelector('.agent-list [role="alert"]')?.textContent.includes('503')`)
    assert.equal((await layout()).list, true, 'Catalog errors remain reachable in narrow navigation')
    await execute(`window.__agentFixture.state.project = 'empty'`)
    await wait(`document.querySelector('.agent-list')?.innerText.includes('No agent types available')`)
    assert.equal((await layout()).overflow, false)
    await execute(`window.__agentFixture.state.legacy = true`)
    await wait(`!!document.querySelector('.legacy-viewers .tool-def')`)
    assert.equal(await execute(`document.querySelector('.tools-embedded, .prompt-embedded') !== null`), false)
    await execute(`document.querySelector('.legacy-viewers .tool-def summary').click()`)
    await wait(`document.querySelector('.legacy-viewers .tool-def').open`)
    assert.match(await execute(`document.querySelector('.legacy-viewers .tool-def-body').innerText`), /path\*/)
    assert.match(await execute(`document.querySelector('.legacy-viewers .system-prompt-content').innerText`), /Legacy renderer/)
    console.log('AGENT_BROWSER_OK')
  } finally { window.destroy(); app.quit() }
}

main().catch(error => { console.error(error); app.exit(1) })
