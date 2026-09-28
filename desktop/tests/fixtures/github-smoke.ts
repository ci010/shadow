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
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(`Boolean(${code})`)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const button = (text: string) => `[...document.querySelectorAll('button')].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)})`
  const click = async (text: string) => {
    await wait(`${button(text)} && !${button(text)}.disabled`)
    return execute(`${button(text)}.click()`)
  }
  const field = (label: string) => `[...document.querySelectorAll('.project-github label')].find(label =>
    [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === ${JSON.stringify(label)})?.querySelector('input, textarea, select')`
  const fill = (label: string, value: string | boolean) => execute(`(() => {
    const field = ${field(label)}; if (!field) throw new Error('Field unavailable: ${label}');
    if (field.type === 'checkbox') field.checked = ${JSON.stringify(value)}; else field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event(field.tagName === 'SELECT' || field.type === 'checkbox' ? 'change' : 'input', {bubbles:true}));
  })()`)
  const expand = (text: string) => execute(`(() => {
    const summary = [...document.querySelectorAll('.project-github summary')].find(summary => summary.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!summary) throw new Error('Section unavailable: ${text}'); summary.parentElement.open = true;
  })()`)
  const command = (command: string) => execute(`fetch('/__fixture', {method:'POST',body:JSON.stringify({command:${JSON.stringify(command)}})}).then(response => response.json())`)
  const stats = () => execute(`fetch('/__stats').then(response => response.json())`)
  const capture = async () => {
    for (const width of [1440, 390]) {
      window.setContentSize(width, 900)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('.github-preview').scrollIntoView({block:'start'})`)
        await delay(100)
        assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'No viewport overflow')
        assert.equal(await execute('document.querySelector(".project-github").scrollWidth <= document.querySelector(".project-github").clientWidth'), true, 'No sidebar overflow')
        if (process.env.GITHUB_SCREENSHOTS) await writeFile(join(process.env.GITHUB_SCREENSHOTS,
          `github-confirm-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(1440, 900)
  }
  try {
    await window.loadURL(new URL('__github', process.env.GITHUB_SMOKE_URL).href)
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 1')
    assert.equal((await stats()).reads, 0, 'Hidden GitHub panel does not load')
    await click('GitHub')
    await wait('document.querySelector(".project-github").textContent.includes("No linked GitHub resources")')
    await execute(`document.querySelector('.coordination-panel > [role="separator"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true, cancelable:true}))`)
    await wait('document.querySelector(".coordination-panel").getBoundingClientRect().width === 424')
    await click('Coordinator')
    assert.equal(await execute('document.querySelector(".coordination-panel").getBoundingClientRect().width'), 424)
    await click('GitHub')
    assert.equal(await execute('document.querySelector(".coordination-panel").getBoundingClientRect().width'), 424)
    await fill('Repository', 'octo/demo')
    await fill('Allow individually confirmed GitHub writes', true)
    await click('Save repository access')
    await wait('document.querySelector(".project-github").textContent.includes("Confirmed writes enabled")')
    await fill('GitHub URL', 'https://github.com/octo/demo/issues/1')
    await click('Load / link resource')
    await wait('document.querySelector(".github-resource")')
    await expand('Import as unassigned Work')
    await fill('Accepted outcome', 'Correct the reviewed behavior')
    await fill('Acceptance, one per line', 'Regression reproduces the original failure\nThe focused regression passes')
    await command('source'); await click('Refresh from GitHub')
    await wait('document.querySelector(".github-resource").textContent.includes("Issue text changed while you were editing")')
    assert.equal(await execute(`${field('Accepted outcome')}.value`), 'Correct the reviewed behavior')
    assert.equal(await execute(`${button('Confirm and create Work')}.disabled`), true)
    await click('Use this reviewed source')
    await click('Confirm and create Work')
    await wait('document.querySelectorAll(".work-board .work-item-card").length === 2')
    await wait('document.querySelector(".work-github")')
    await expand('Prepare a GitHub write')
    await fill('Exact text to publish', 'Owner-approved progress update only.')
    await click('Reload integration')
    await wait(`!${button('Reload integration')}.disabled`)
    assert.equal(await execute(`${field('Exact text to publish')}.value`), 'Owner-approved progress update only.')
    await click('Prepare preview')
    await wait('document.querySelector(".github-preview")')
    assert.equal((await stats()).writes, 0, 'Preview never writes to GitHub')
    assert.equal(await execute(`${button('Confirm GitHub write')}.disabled`), true)
    assert.match(await execute('document.querySelector(".github-preview").textContent'), /https:\/\/github.com\/octo\/demo\/issues\/1/)
    await capture()
    await fill('I reviewed the destination and exact content.', true)
    await click('Confirm GitHub write')
    await wait('!document.querySelector(".github-preview") && document.querySelector(".project-github").textContent.includes("succeeded")')
    assert.equal((await stats()).writes, 1)
    await fill('Exact text to publish', 'A second approved update with a lost response.')
    await click('Prepare preview'); await wait('document.querySelector(".github-preview")')
    await command('uncertain')
    await fill('I reviewed the destination and exact content.', true)
    await click('Confirm GitHub write')
    await wait('document.querySelector(".project-github").textContent.includes("outcome is unknown")')
    await expand('Write receipts')
    await click('Reconcile with GitHub')
    await wait('document.querySelector(".project-github").textContent.includes("reconciled")')
    assert.equal((await stats()).writes, 2, 'Reconciliation never republishes')
    await command('online')
    await expand('Automatic follow-up')
    await fill('Recipient', 'web:orchestrator'); await fill('Delivery', 'queue'); await fill('source', true)
    await click('Enable / update subscription')
    await wait('document.querySelector(".project-github").textContent.includes("Current: queue")')
    await fill('Delivery', 'silent')
    await click('Reload integration'); await wait(`!${button('Reload integration')}.disabled`)
    assert.equal(await execute(`${field('Delivery')}.value`), 'silent', 'Refresh does not discard unsaved subscription edits')
    await command('source'); await click('Refresh from GitHub')
    await wait('document.querySelector(".project-github").textContent.includes("Follow-up deliveries · 1")')
    assert.equal((await stats()).deliveries, 1)
    await command('offline'); await click('Refresh from GitHub')
    await wait('document.querySelector(".github-resource").textContent.includes("Last snapshot retained")')
    await command('online')
    await execute('document.querySelector("[aria-label=\\"Close coordination panel\\"]").click()')
    await delay(150)
    const before = (await stats()).reads
    await execute('window.invalidateWork()'); await delay(200)
    assert.equal((await stats()).reads, before, 'Hidden panel releases its snapshot listener')
    await execute('window.setAdmin(false)')
    await click('GitHub')
    await wait(`!${button('Reload integration')}.disabled`)
    assert.equal(await execute(`${button('Refresh from GitHub')}.disabled`), true)
    assert.equal(await execute('document.querySelectorAll(".project-github form").length'), 0)
    assert.equal((await stats()).writes, 2)
    console.log('GITHUB_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
