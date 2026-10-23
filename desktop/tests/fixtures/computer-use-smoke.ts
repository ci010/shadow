import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(40) }
    throw new Error(`Timed out: ${code}`)
  }
  try {
    await window.loadURL(new URL('__computer', process.env.COMPUTER_SMOKE_URL).href)
    await wait(`window.fixture?.requests.length > 0`)
    assert.equal(await execute(`document.querySelector('[role="alert"]')`), null, 'Passive availability failure must not become a chat error')
    await execute(`window.fixture.statusMode='ok'`)
    assert.equal(await execute(`document.querySelector('.computer-control')`), null, 'Inactive capability must not occupy the composer')
    assert.equal(await execute(`window.fixture.requests.some(r=>r.method==='POST')`), false)
    await wait(`window.fixture.requests.length > 1`)
    assert.equal(await execute(`document.querySelector('.computer-control')`), null, 'Ready must stay invisible')
    assert.equal(await execute(`document.querySelector('select')`), null)
    // Simulate the server status after the agent selects a target, without any UI listing/sharing.
    await execute(`window.fixture.state.grant={target:window.fixture.target,expiresAt:new Date(Date.now()+600000).toISOString()}`)
    await wait(`document.querySelector('.computer-stop-access')`)
    assert.equal(await execute(`document.querySelector('.computer-control')`), null, 'Agent selection must not show an access banner')
    assert.equal(await execute(`document.querySelector('#fixture-composer .computer-stop-access').disabled`), false)
    assert.equal(await execute(`document.querySelector('.computer-stop-access').getAttribute('aria-label')`), 'Stop all desktop access')
    assert.deepEqual(await execute('window.fixture.shares'), [])
    assert.deepEqual(await execute('window.fixture.permissions'), [])
    assert.deepEqual(await execute('window.fixture.decisions'), [])
    assert.equal(await execute(`document.querySelector('input[type=checkbox]')`), null)
    assert.equal(await execute(`window.fixture.requests.some(r=>r.method==='POST')`), false, 'No permission or sharing prerequisite')
    // Foreground reviews appear automatically; there is no separate input switch.
    await execute(`window.fixture.state.pending={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',targetId:window.fixture.state.grant.target.id,observationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expiresAt:new Date(Date.now()+60000).toISOString(),action:{kind:'type_text',elementId:'0',text:'Synthetic insertion at current selection'},element:{name:'Fixture input',role:'ControlType.Edit'}}`)
    await wait(`document.body.innerText.includes('Approve this action once?')`)
    assert.equal(await execute(`document.querySelectorAll('.computer-target img').length`), 0, 'Window titles must not become HTML')
    for (const width of [1100, 390]) {
      window.setContentSize(width, 900)
      await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'), true)
      assert.equal(await execute(`document.querySelector('.computer-stop').disabled`), false)
      assert.equal(await execute(`document.querySelector('.computer-body pre').textContent`), 'Synthetic insertion at current selection')
    }
    await execute(`document.querySelector('.computer-actions .computer-primary').click()`)
    await wait(`window.fixture.decisions.length===1`)
    assert.deepEqual(await execute('window.fixture.decisions'), [{ approved: true }])
    await execute(`window.fixture.state.pending={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',targetId:window.fixture.state.grant.target.id,observationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expiresAt:new Date(Date.now()+60000).toISOString(),action:{kind:'drag',x:80,y:70,toX:300,toY:230,durationMs:300,modifiers:['SHIFT']},element:null,frame:{width:400,height:300}}`)
    await wait(`document.querySelector('.computer-markers') && !document.querySelector('.computer-actions .computer-primary').disabled`)
    for (const locale of ['en', 'zh-CN']) {
      await execute(`window.fixture.setLocalePreference('${locale}')`)
      for (const width of [1100, 390]) {
        window.setContentSize(width, 900)
        await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'), true)
        assert.equal(await execute(`document.querySelector('.computer-stop').disabled`), false)
        assert.equal(await execute(`document.querySelector('.computer-frame img').naturalWidth`), 400)
        assert.equal(await execute(`document.querySelector('.computer-frame img').src.startsWith('blob:')`), true)
        assert.equal(await execute(`document.querySelector('.computer-markers').getAttribute('viewBox')`), '0 0 400 300')
        assert.equal(await execute(`document.querySelector('.computer-markers circle').getAttribute('cx')`), '80.5')
        assert.equal(await execute(`document.querySelector('.computer-markers line').getAttribute('x2')`), '300.5')
        assert.equal(await execute(`document.querySelector('.computer-body kbd').textContent`), 'SHIFT')
        assert.equal(await execute(`Math.abs(document.querySelector('.computer-frame img').getBoundingClientRect().width-document.querySelector('.computer-markers').getBoundingClientRect().width)<0.1`), true)
      }
    }
    await execute(`document.querySelector('.computer-actions button:not(.computer-primary)').click()`)
    await wait(`window.fixture.decisions.length===2 && !document.querySelector('.computer-frame')`)
    await execute(`window.fixture.setLocalePreference('en');window.fixture.frameMode='error';window.fixture.state.pending={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',targetId:window.fixture.state.grant.target.id,observationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expiresAt:new Date(Date.now()+60000).toISOString(),action:{kind:'move',x:20,y:30},element:null,frame:{width:400,height:300}}`)
    await wait(`document.body.innerText.includes('The review screenshot could not be loaded.')`)
    assert.equal(await execute(`document.querySelector('.computer-actions .computer-primary').disabled`), true)
    assert.equal(await execute(`document.querySelector('.computer-actions button:not(.computer-primary)').disabled`), false)
    await execute(`document.querySelector('.computer-actions button:not(.computer-primary)').click()`)
    await wait(`window.fixture.decisions.length===3`)
    await execute(`window.fixture.state.pending={id:'ffffffff-ffff-4fff-8fff-ffffffffffff',targetId:window.fixture.state.grant.target.id,observationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expiresAt:new Date(Date.now()+60000).toISOString(),action:{kind:'press_key',elementId:'0',key:'ARROW_LEFT',modifiers:['CTRL','SHIFT']},element:{name:'Fixture input',role:'ControlType.Edit'}}`)
    await wait(`document.querySelector('.computer-body kbd')?.textContent==='CTRL + SHIFT + ARROW_LEFT'`)
    assert.equal(await execute(`document.querySelector('.computer-foreground').textContent.includes('input focus')`), true)
    assert.equal(await execute(`document.querySelectorAll('.computer-frame').length`), 0)
    assert.equal(await execute(`document.querySelector('.computer-actions .computer-primary').disabled`), false)
    await execute(`window.fixture.setLocalePreference('zh-CN')`)
    await wait(`document.body.innerText.includes('电脑操作')`)
    assert.equal(await execute(`document.body.innerText.includes('立即停止桌面访问')`), true)
    await execute(`document.querySelector('#fixture-composer .computer-stop-access').click()`)
    await wait(`window.fixture.stops===1 && !document.querySelector('.computer-control')`)
    console.log('COMPUTER_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
