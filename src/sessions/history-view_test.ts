import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../providers/provider.ts'
import { formatSessionHistory } from './history-view.ts'

function call(name: string, args: unknown, id = 'a/b'): ChatMessage {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }
}
function result(content: string): ChatMessage { return { role: 'tool', content, tool_call_id: 'a/b' } }
const view = (messages: ChatMessage[], overview = true) => formatSessionHistory(messages, overview, 'physical')

test('overview hides ordinary payloads and retains exact links; full is unchanged', () => {
  const messages = [call('write', { path: '/ordinary', content: 'SECRET' }), result('SECRET RESULT')]
  const text = view(messages)
  assert.doesNotMatch(text, /SECRET/)
  assert.match(text, /calls\/a%2Fb/)
  assert.equal(view(messages, false), '    #1 [ASSISTANT]\n  [call a/b] write({"path":"/ordinary","content":"SECRET"})\n\n    #2 [TOOL]\n[result for a/b] SECRET RESULT')
})
test('folder attempts and bounded result evidence do not infer success', () => {
  const text = view([call('use_project', { folder: 'docs' }), result('Error: unavailable')])
  assert.match(text, /attempt folder="docs"/)
  assert.match(text, /error evidence="Error: unavailable"/)
  assert.doesNotMatch(text, /success/)
  assert.match(view([call('use_project', { folder: 'docs' }), result('Working context committed: folder="id".')]), /observed result evidence=/)
  assert.match(view([call('use_project', '{')]), /invalid or oversized arguments/)
  assert.match(view([call('use_project', {})]), /invalid or missing/)
})
test('self metadata attempts and results expose only supported bounded fields', () => {
  const content = JSON.stringify({ title: 'Title', description: 'Details', completed: false, cwd: '/work', projectDir: '/home', unknown: 'SECRET' })
  const messages = [call('write', { path: 'v:session/self.json', content }), result(content)]
  const text = view(messages)
  for (const field of ['title="Title"', 'description="Details"', 'completed=false', 'cwd="/work"', 'projectDir="/home"']) assert.ok(text.includes(field))
  assert.match(text, /observed metadata result/)
  assert.doesNotMatch(text, /SECRET/)
  assert.match(view([messages[0]!, result('Error: denied')]), /error evidence=/)
  assert.match(view([messages[0]!, result('unrecognized')]), /status unknown/)
})
test('exact path, malformed values, large and unknown metadata are safe', () => {
  for (const path of ['v:session/other.json', 'v:session/self.json/extra', 'v:session/self.json?x']) {
    assert.doesNotMatch(view([call('write', { path, content: '{"title":"SECRET"}' })]), /SECRET/)
  }
  for (const content of ['{SECRET', '[]', 'x'.repeat(33_000)]) {
    const text = view([call('write', { path: 'v:session/self.json', content })])
    assert.doesNotMatch(text, /SECRET|x{100}/)
  }
  const text = view([call('write', { path: 'v:session/self.json', content: JSON.stringify({ title: { nested: 'SECRET' }, description: 'z'.repeat(1000), completed: [] }) })])
  assert.doesNotMatch(text, /SECRET|z{201}/)
  assert.match(text, /invalid type/)
  assert.doesNotThrow(() => view([call('write', '{')]))
})
test('edit and append requests do not masquerade as final self state', () => {
  for (const args of [{ match: 'false', content: 'true' }, { flag: 'a', content: '{"completed":true}' }]) {
    const text = view([call('write', { path: 'v:session/self.json', ...args })])
    assert.match(text, /content omitted/)
    assert.doesNotMatch(text, /completed=true/)
  }
})
test('prefix formatting stays stable, and orphan results stay hidden', () => {
  const first = call('use_project', { folder: 'docs' })
  const messages = [first, result('Error: failed')]
  assert.ok(view(messages).startsWith(view([first])))
  assert.doesNotMatch(view([messages[1]!]), /failed/)
})

test('self full payload and every overview prefix remain independent of later results', () => {
  const content = '{"completed":true}'
  const messages = [call('write', { path: 'v:session/self.json', content }), result(content), call('use_project', { folder: 'docs' }, 'next')]
  assert.match(view(messages, false), /\[result for a\/b\] {"completed":true}/)
  assert.match(view(messages, false), /write\({"path":"v:session\/self.json","content":/)
  for (let end = 1; end <= messages.length; end++) {
    assert.ok(view(messages).startsWith(view(messages.slice(0, end))))
  }
})
