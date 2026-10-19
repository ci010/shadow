import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1280, height: 960,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message)
  })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (condition: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(condition)) return; await delay(50) }
    throw new Error(`Timed out: ${condition}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const button = (text: string) => `[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)})`
  const field = (label: string, tag: string) => `[...document.querySelectorAll('label')].find(item=>item.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector(${JSON.stringify(tag)})`
  const click = async (text: string) => {
    await wait(`${button(text)} && !${button(text)}.disabled`)
    await execute(`${button(text)}.click()`); await delay(80)
  }
  const select = async (label: string, value: string) => {
    await execute(`{const item=${field(label, 'select')}; item.value=${JSON.stringify(value)}; item.dispatchEvent(new Event('change',{bubbles:true}));}`)
  }
  const capture = async (name: string) => {
    if (!process.env.DISCORD_ACCESS_ARTIFACTS) return
    await mkdir(process.env.DISCORD_ACCESS_ARTIFACTS, { recursive: true })
    await execute('scrollTo(0,0); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await delay(250)
    await writeFile(join(process.env.DISCORD_ACCESS_ARTIFACTS, `discord-${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(process.env.DISCORD_ACCESS_URL!)
    await wait(`${field('Server', 'select')}?.options.length === 2`)
    await select('Server', '100')
    await wait(`document.querySelectorAll('.picker-row').length === 2`)
    await execute(`{const item=${field('Published Agent', 'select')}; item.selectedIndex=1; item.dispatchEvent(new Event('change',{bubbles:true}));}`)
    await execute(`(async()=>{for (const item of document.querySelectorAll('.picker-row input')) {
      item.click(); await new Promise(resolve=>setTimeout(resolve,0));
    } ${field('Everyone who can send', 'input')}.click();})()`)
    assert.equal(await execute("[...document.querySelectorAll('.picker-row')].some(row => row.textContent.includes('Forum product-questions') && !row.querySelector('input').disabled)"), true,
      'Forum parents are named, selectable assignment containers')
    assert.equal(await execute("document.body.innerText.includes('Each post has separate history; the forum parent is not a chat.')"), true)
    assert.equal(await execute(`${field('New public threads inherit', 'input')}.checked`), true)
    await execute('window.__refreshBot()')
    assert.equal(await execute("document.querySelectorAll('.picker-row input:checked').length"), 2,
      'Status polling preserves channel selections')
    await click('Review assignments')
    await wait(`${button('Approve and apply')} && document.querySelector('.review-assignment')`)
    assert.equal(await execute(`${button('Approve and apply')}.disabled`), true)
    await execute(`${field('I reviewed the exact text', 'input')}.click()`)
    await execute('window.__refreshBot()')
    assert.equal(await execute(`${button('Approve and apply')}?.disabled`), false,
      'Status polling preserves the selected review and acknowledgment')
    await click('Approve and apply')
    await wait(`document.body.innerText.includes('Reviewed change applied')`)
    await click('Return to current assignments and test access')
    await wait(`document.querySelectorAll('.saved-row').length === 2`)
    assert.equal(await execute("document.body.innerText.includes('Bot can send at last sync')"), true)
    await select('Server', '100')
    await wait(`document.querySelectorAll('.picker-row').length === 2 && !${button('Refresh configuration')}.disabled`)
    await capture('desktop')
    await click('Agents')
    await execute(`{const item=${field('Edit a published Agent', 'select')}; item.selectedIndex=1; item.dispatchEvent(new Event('change',{bubbles:true}));}`)
    await wait(`document.querySelector('.code-input')?.value.includes('approved help articles')`)
    assert.equal(await execute(`${field('Stable name', 'input')}.disabled`), true)
    await execute(`{
      const item=document.querySelector('.code-input');
      item.value+='\\nUNSAVED_POLLING_CANARY';
      item.dispatchEvent(new Event('input',{bubbles:true}));
      item.focus(); item.setSelectionRange(4,9);
      window.__editingElement=item;
    }`)
    for (let index = 0; index < 3; index++) await execute('window.__refreshBot()')
    assert.equal(await execute(`document.querySelector('.code-input') === window.__editingElement &&
      document.activeElement === window.__editingElement &&
      window.__editingElement.value.includes('UNSAVED_POLLING_CANARY') &&
      window.__editingElement.selectionStart === 4 && window.__editingElement.selectionEnd === 9`), true,
    'Fresh Bot status objects must not reset Agent text, focus, selection or the current tab')
    await click('Knowledge')
    await execute(`document.querySelector('details summary').click()`)
    await wait(`document.body.innerText.includes('The source cursor has not advanced')`)
    await execute(`{for (const text of ['Destination domain','Start from a saved resource']) {
      const item=[...document.querySelectorAll('label')].find(label=>label.textContent.trim().startsWith(text)).querySelector('select');
      item.selectedIndex=1; item.dispatchEvent(new Event('change',{bubbles:true}));
    }}`)
    await wait(`${field('Exact text to share', 'textarea')}?.value.includes('No private account details')`)
    await click('Review knowledge publication')
    await wait(`document.querySelector('.review-body pre')?.textContent.includes('No private account details')`)
    const linkedReview = await execute("document.querySelector('.review-body').closest('[data-review-id]').dataset.reviewId")
    assert.equal(await execute(`${button('Approve and apply')}.disabled`), true)
    await capture('review')
    await click('Channels & people')
    window.setSize(390, 844)
    await delay(250)
    assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'Mobile settings never cause horizontal page overflow')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.form-grid')).gridTemplateColumns.split(' ').length`), 1)
    await capture('mobile')
    await click('Agents')
    await execute('window.__switchBot()')
    await wait(`${field('Server', 'select')}?.options.length === 2`)
    await click('Agents')
    assert.equal(await execute(`${field('Display name', 'input')}.value`), '',
      'Changing Bot identity still clears the old draft')
    assert.equal(await execute(`document.querySelector('.code-input').value.includes('UNSAVED_POLLING_CANARY')`), false)
    await execute('window.__switchProject()')
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('another Project')`)
    assert.equal(await execute('document.querySelector(".code-input")'), null, 'Old Project instructions disappear when ownership changes')
    await execute(`window.__openReviewSettings(${JSON.stringify(linkedReview)})`)
    await wait(`document.querySelector('.review-body pre')?.textContent.includes('No private account details')`)
    assert.equal(await execute(`${button('Approve and apply')}.disabled`), true,
      'Following an owner-chat review link opens the Bot and exact review, never approves it')
    assert.equal(await execute(`${field('I reviewed the exact text', 'input')}.checked`), false)
    await click('Refresh status')
    assert.equal(await execute(`document.querySelector('.review-body')?.closest('[data-review-id]').dataset.reviewId`), linkedReview)
    await click('I have invited the Bot — continue to assignments')
    await wait(`document.querySelectorAll('.saved-row').length === 2`)
    assert.equal(await execute("document.body.innerText.includes('Channel name not resolved')"), true, 'A reopened guild-page directory is unresolved, not unavailable')
    await click('Sync this server')
    await wait(`document.querySelector('.saved-row strong')?.textContent.includes('customer-help')`)
    await click('Review and approve access')
    await wait(`document.querySelector('.review-row') !== null`)
    await click('Publish and assign an Agent')
    await wait(`document.querySelector('.saved-section') !== null`)
    await execute(`window.__openReviewSettings('11111111-1111-4111-8111-111111111111')`)
    await wait(`document.body.innerText.includes('This review is unavailable')`)
    assert.equal(await execute('document.querySelector(".review-body")'), null)
    await execute(`window.__openReviewSettings(${JSON.stringify(linkedReview)},'missing-bot')`)
    await wait(`document.body.innerText.includes('linked Discord Bot is unavailable')`)
    assert(!errors.some(error => error.includes('Unhandled error')), errors.join('\n'))
    console.log('DISCORD_ACCESS_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
