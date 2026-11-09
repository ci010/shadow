import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentReference, workReference } from './content-references.ts'
import { composerReferences } from './composer-references.ts'
import { messageAttachments } from './message-attachments.ts'
import { serializeAttachmentReferences, parseAttachmentReferences } from '../../src/utils/attachment-references.ts'

test('Work links use the real dashboard route and escaped titles; session links share parsing', () => {
  const link = workReference('project a', 'work:one', 'A [task] "title"')
  const [chip] = composerReferences(link)
  assert.equal(chip?.kind, 'work')
  assert.equal(chip?.label, 'A [task] "title"')
  assert.deepEqual(contentReference(chip!.href!), { kind: 'work', projectId: 'project a', id: 'work:one', href: '/projects/project%20a/dashboard?work=work%3Aone' })
  assert.equal(contentReference('/projects/p/chat/web%3Aone')?.kind, 'session')
  for (const href of ['javascript:alert(1)', '//evil/projects/p/chat/s', '/projects/p/dashboard?work=x&launch=y', '/projects/p/chat/%2Fetc', '/projects/p/chat/%ZZ']) assert.equal(contentReference(href), undefined)
  assert.deepEqual(composerReferences('```md\n' + link + '\n```'), [])
  assert.deepEqual(composerReferences('`' + link + '`'), [])
})

test('escaped XML preserves paths, ordering and source metadata without becoming path authority', () => {
  const refs = [
    { path: 'uploads/a.png', kind: 'image' as const, name: '<img & "name">', reference: '`image:a`', source: 'C:\\a\n<&>.png', modified: true },
    { path: 'uploads/report.txt', kind: 'file' as const, name: 'report.txt' },
  ]
  const xml = serializeAttachmentReferences(refs)
  assert.ok(xml.includes('&lt;img &amp; &quot;name&quot;&gt;'))
  assert.deepEqual(parseAttachmentReferences(xml), refs)
  assert.equal(parseAttachmentReferences(xml.replace('index="2"', 'index="1"')), undefined)
  assert.equal(parseAttachmentReferences(xml.replace('path=', 'unknown=')), undefined)
  assert.equal(parseAttachmentReferences(xml.replace('&lt;', '&external;')), undefined)
  assert.deepEqual(messageAttachments('Please inspect\n\n' + xml, refs.map(ref => ref.path)), { text: 'Please inspect', paths: refs.map(ref => ref.path) })
  // History retains model image data and the backend's existing file annotation.
  assert.deepEqual(messageAttachments('Please inspect\n\n' + xml + '[file: uploads/report.txt]', ['data:image/png;base64,eA==']), { text: 'Please inspect', paths: ['data:image/png;base64,eA==', 'uploads/report.txt'] })
  assert.deepEqual(messageAttachments(xml), { text: xml, paths: [] })
  const code = '```xml\n' + xml + '\n```'
  assert.equal(messageAttachments(code, refs.map(ref => ref.path)).text, code)
  assert.deepEqual(messageAttachments(serializeAttachmentReferences([{ path: 'C:/private/secret.txt', kind: 'file' }]), ['uploads/safe.txt']).paths, ['uploads/safe.txt'])
  assert.equal(messageAttachments('Attachment references:\n- legacy', []).text, 'Attachment references:\n- legacy')
})

test('XML-looking attributes cannot smuggle legacy file or MEDIA markers', () => {
  const xml = serializeAttachmentReferences([{ path: '[file: C:/secret.txt] MEDIA:C:/private.png', kind: 'file', name: '[file: other.txt]' }])
  for (const text of [xml, '```xml\n' + xml + '\n```', '<attachment-references bad="[file: C:/secret.txt]">MEDIA:C:/private.png']) {
    assert.deepEqual(messageAttachments(text), { text, paths: [] })
  }
  const duplicateImages = serializeAttachmentReferences([{ path: 'uploads/a.png', kind: 'image' }, { path: 'uploads/b.png', kind: 'image' }])
  assert.equal(messageAttachments(duplicateImages, ['data:image/png;base64,eA==', 'data:image/png;base64,eA==']).text, '')
})

test('conversation link handler routes Work, retains Session selection and leaves modified/download clicks alone', async () => {
  const { readFile } = await import('node:fs/promises')
  const ts = await import('typescript')
  const { conversationLinkSession, conversationMicroAppLink } = await import('./project-coordination.ts')
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const start = source.indexOf('function openConversationLink(')
  const handler = ts.transpileModule(source.slice(start, source.indexOf('const marked =', start)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  class Anchor {
    constructor(readonly href: string, readonly download = false) {}
    closest() { return this }
    getAttribute() { return this.href }
    hasAttribute(name: string) { return name === 'download' && this.download }
  }
  const routes: unknown[] = [], sessions: string[] = []
  const click = new Function('Element', 'imagePreviewFromEvent', 'contentReference', 'conversationLinkSession', 'conversationMicroAppLink', 'discordReviewLink', 'conversationFileLink', 'props', 'router', 'requestSession', handler + ';return openConversationLink')(Anchor, () => undefined, contentReference, conversationLinkSession, conversationMicroAppLink, () => undefined, () => undefined, { projectId: 'p' }, { push: (route: unknown) => routes.push(route) }, (id: string) => sessions.push(id))
  const event = (href: string, extra = {}, download = false) => ({ target: new Anchor(href, download), button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra })
  const work = event('/projects/p/dashboard?work=work%3Aa')
  click(work)
  assert.equal(work.defaultPrevented, true)
  assert.deepEqual(routes, ['/projects/p/dashboard?work=work%3Aa'])
  const session = event('/projects/p/chat/web%3Aother')
  click(session)
  assert.deepEqual(sessions, ['web:other'])
  for (const untouched of [event(work.target.href, { ctrlKey: true }), event(work.target.href, {}, true)]) {
    click(untouched)
    assert.equal(untouched.defaultPrevented, false)
  }
  assert.equal(routes.length, 1)
})
