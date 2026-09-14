import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openaiChat } from './openai-compatible.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'

for (const providerName of ['openai', 'copilot', 'deepseek', 'custom']) {
  test(`${providerName} Chat honors disabled thinking ahead of inherited effort and preserves defaults`, async (t) => {
    const bodies: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return Response.json({ choices: [{ message: { content: 'Done' } }] })
    })
    const options = [
      { thinking: { type: 'disabled' as const } },
      { thinking: { type: 'disabled' as const }, reasoningEffort: 'high' as const },
      {},
      { reasoningEffort: 'high' as const },
      { thinking: { type: 'enabled' as const } },
      ...(['low', 'high', 'max'] as const).map(reasoningEffort => ({
        thinking: { type: 'enabled' as const }, reasoningEffort,
      })),
    ]
    for (const option of options) {
      await openaiChat({
        url: 'https://synthetic.invalid/chat/completions', apiKey: 'synthetic-key',
        model: 'synthetic-model', providerName, messages: [], tools: [], ...option,
      })
    }

    for (const providerName of ['openai', 'copilot', 'custom']) {
      test(`${providerName} GPT forwards every effort unchanged and uses native no-thinking parameters`, async (t) => {
        const bodies: Record<string, unknown>[] = []
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({ choices: [{ message: { content: 'Done' } }] })
        })
        const request = {
          url: 'https://synthetic.invalid/chat/completions', apiKey: 'synthetic-key',
          model: 'gpt-6-astra', providerName, messages: [], tools: [],
        }
        for (const reasoningEffort of REASONING_EFFORTS) {
          await openaiChat({ ...request, reasoningEffort, thinking: { type: 'enabled' } })
        }
        await openaiChat({ ...request, reasoningEffort: 'xhigh', thinking: { type: 'disabled' } })
        await openaiChat(request)
        assert.deepEqual(bodies.map(body => body.reasoning_effort), [...REASONING_EFFORTS, 'none', undefined])
        assert(bodies.every(body => !('thinking' in body)))
      })
    }
    const nativeOpenAI = providerName === 'openai' || providerName === 'copilot'
    for (const body of bodies.slice(0, 2)) {
      assert.equal(body.reasoning_effort, nativeOpenAI ? 'none' : undefined)
      assert.deepEqual(body.thinking, nativeOpenAI ? undefined : { type: 'disabled' })
    }
    assert.equal('thinking' in bodies[2], false)
    assert.equal('reasoning_effort' in bodies[2], false)
    assert.equal(bodies[3].reasoning_effort, 'high')
    assert.equal('thinking' in bodies[3], false)
    assert.deepEqual(bodies[4].thinking, { type: 'enabled' })
    assert.equal('reasoning_effort' in bodies[4], false)
    assert.deepEqual(bodies.slice(5).map(body => body.reasoning_effort), ['low', 'high', 'max'])
    assert.ok(bodies.slice(5).every(body => JSON.stringify(body.thinking) === '{"type":"enabled"}'))
  })
}
