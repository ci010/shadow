import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = (text: string) => execute(`(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
    button.click();
  })()`)
  const fill = (index: number, value: string) => execute(`(() => {
    const field = document.querySelectorAll('textarea')[${index}];
    field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  try {
    await window.loadURL(new URL('__work', process.env.WORK_SMOKE_URL).href)
    await wait(`document.querySelector('.work-alignment')`)
    await execute(`document.querySelector('.work-alignment > summary').click()`)
    await wait(`document.body.innerText.includes('Run both evaluations')`)
    assert.match(await execute('document.body.innerText'), /Agent interpretation.*not a quoted user requirement/)
    assert.match(await execute('document.body.innerText'), /Agent-chosen next phase/)
    await click('Fresh context')
    await wait(`document.body.innerText.includes('next safe boundary')`)
    await click('Confirm fresh')
    await wait(`![...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Confirm fresh')`)
    await click('Revise agreement')
    await wait(`document.querySelectorAll('textarea').length === 4`)
    await fill(0, 'Corrected final outcome')
    await fill(3, 'Conflict')
    await execute(`document.querySelector('form').requestSubmit()`)
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('revision changed')`)
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Corrected final outcome')
    await fill(3, 'Correct agent interpretation, not a changed user request')
    await execute(`document.querySelector('form').requestSubmit()`)
    await wait(`!document.querySelector('form') && document.body.innerText.includes('Human-confirmed agreement')`)
    assert.match(await execute('document.body.innerText'), /Awaiting executor adoption/)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await delay(50)
      assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
    }
    await execute(`window.fixture.canWrite = false`)
    await wait(`document.body.innerText.includes('Corrected final outcome') && ![...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Revise agreement')`)
    assert.match(await execute('document.body.innerText'), /Corrected final outcome/)
    console.log('WORK_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
