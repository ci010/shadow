/** Isolated Electron renderer harness, launched by composer-references-rendered_test.ts. */
import assert from 'node:assert/strict'
import { withComposerTestAdapter } from './composer-test-adapter.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { sandbox: true } })
  const run = (s: string) => window.webContents.executeJavaScript(withComposerTestAdapter(s))
  try {
    await window.loadURL(new URL('__activity', process.env.ACTIVITY_SMOKE_URL).href)
    for (let i = 0; i < 250 && !await run('!!window.fixture'); i++) await delay(40)
    assert.equal(await run(`(async () => {
      const f=window.fixture,e=document.querySelector('.reference-composer');
      const check=(v,m)=>{if(!v)throw Error(m)};
      const initial=f.text.value;window.initialReferenceText=initial;
      check(e.querySelectorAll('[data-reference]').length===2,'two inline chips');
      check(e.value===initial,'smoke adapter reads serialized chip text');
      e.focus();e.setSelectionRange(0,initial.length);
      check(e.selectionStart===0 && e.selectionEnd===initial.length,'smoke adapter uses actual serialized range');
      check(e.disabled===false,'smoke adapter reads aria disabled');
      check(!e.textContent.includes('Historical content'),'metadata hidden');
      check(e.querySelector('a').getAttribute('href')==='/projects/p/chat/web%3Aother','source link');
      f.input.value.focus();f.input.value.setSelectionRange(4,4);
      document.execCommand('insertText',false,'typed ');
      check(f.text.value.startsWith('see typed '),'native typing before chip');
      check(f.input.value.selectionStart===10,'serialized caret after typing');
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
      check(f.text.value===initial,'undo native typing');
      const button=e.querySelector('.composer-reference button');
      button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      check(f.keys.length===0,'chip action does not submit');
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      check(f.keys.join()==='Enter','editor submit forwarded');
      f.input.value.setSelectionRange(0,0);
      e.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertParagraph',bubbles:true,cancelable:true}));
      check(f.text.value.startsWith('\\n'),'newline insertion');
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
      const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});
      paste.clipboardData.setData('text/plain','<b>plain</b>\\n');e.dispatchEvent(paste);
      check(f.text.value.startsWith('<b>plain</b>\\n'),'plain multiline paste');
      check(!e.querySelector('b'),'no html injection');
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
      check(f.text.value===initial,'undo paste');
      f.input.value.setSelectionRange(0,initial.length);
      const cp=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});e.dispatchEvent(cp);
      check(cp.clipboardData.getData('text/plain')===initial,'copy original protocol');
      f.input.value.setSelectionRange(initial.length,initial.length);
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
      check(!f.text.value.endsWith('IMAGE'),'atomic backspace');
      e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
      check(f.text.value===initial,'undo chip deletion');
      e.querySelector('[data-reference="IMAGE"] .composer-reference-source').click();
      check(f.preview.value==='image-key','image preview');
      e.querySelector('.composer-reference button[aria-label^="Remove"]').click();
      check(!f.text.value.includes('Historical content'),'remove complete metadata');
      f.input.value.setSelectionRange(0,0);
      e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      e.firstChild.textContent='测试';
      e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
      check(!f.text.value.startsWith('测试'),'IME not published early');
      e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
      check(f.text.value.startsWith('测试'),'IME commit');
      await new Promise(r=>setTimeout(r,0));
      f.text.value=f.insertSessionReference('@',{start:0,end:1},{sessionId:'web:long',title:'W'.repeat(300)},'p').text+'IMAGE';
      await new Promise(r=>setTimeout(r,0));
      check(e.querySelectorAll('[data-reference]').length===2,'external completion projects as chips');
      const dropped=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});
      dropped.dataTransfer.setData('text/html','<img src=x onerror=alert(1)>');e.dispatchEvent(dropped);
      check(dropped.defaultPrevented,'native rich drop blocked');
      return true;
    })()`), true)
    // Exercise real Chromium editing, not just synthetic beforeinput events.
    await run(`window.fixture.text.value=''`)
    await delay(30)
    assert.equal(await run(`document.querySelector('.reference-composer').childNodes.length`), 0)
    await run(`window.fixture.input.value.focus()`)
    await window.webContents.insertText('首')
    assert.equal(await run(`window.fixture.text.value`), '首')
    await run(`window.firstTypedNode=document.querySelector('.reference-composer').firstChild`)
    await window.webContents.insertText('字')
    assert.equal(await run(`document.querySelector('.reference-composer').firstChild===window.firstTypedNode`), true, 'ordinary typing preserves the active text node')
    await run(`window.caretTop=()=>{const r=getSelection().getRangeAt(0).cloneRange();r.collapse(false);return r.getBoundingClientRect().top};window.beforeNewline=window.caretTop()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] })
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] })
    await delay(30)
    assert.equal(await run(`window.fixture.text.value`), '首字\n')
    assert.equal(await run(`window.fixture.input.value.selectionStart`), 3, 'layout break does not add serialized text')
    await window.webContents.insertText('下一行')
    assert.equal(await run(`window.fixture.text.value`), '首字\n下一行')
    assert.equal(await run(`window.caretTop()>window.beforeNewline+10`), true, 'first Shift+Enter places subsequent typing on the next visual line')
    await run(`window.fixture.text.value=window.initialReferenceText`)
    await delay(30)
    for (const width of [800, 375]) {
      window.setSize(width, 700)
      await delay(60)
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true)
    }
    await run(`window.fixture.text.value=window.fixture.workReference('p','work:one','Work <title>')`)
    await delay(50)
    assert.equal(await run(`document.querySelector('.composer-reference-source').textContent`), 'Work <title>')
    assert.equal(await run(`document.querySelector('.composer-reference-source').getAttribute('href')`), '/projects/p/dashboard?work=work%3Aone')
    assert.equal(await run(`!!document.querySelector('.composer-reference .i-lucide-list-checks')`), true)
    assert.equal(await run(`!!document.querySelector('.reference-composer title')`), false)
    await run('window.fixture.text.value=window.initialReferenceText');
    await delay(50);
    if (process.env.TOOL_DIFF_SCREENSHOTS) {
      await mkdir(process.env.TOOL_DIFF_SCREENSHOTS, { recursive: true })
      await writeFile(join(process.env.TOOL_DIFF_SCREENSHOTS, 'composer.png'), (await window.webContents.capturePage()).toPNG())
    }
    console.log('SESSION_REFERENCE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
