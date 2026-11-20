import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startMainRuntime } from './start.ts'

test('a real Project advertises neither old audio/diffusion tool contracts nor callable aliases', { timeout: 30_000 }, async () => {
  await withTempWorkspace(async root => {
    const names = ['audio', 'audio_cpp', 'diffusion_cpp', 'audio-cpp', 'diffusion-cpp']
    const calls = names.flatMap(name => [
      { name: 'read', args: { path: `v:tools/${name}` } },
      { name: 'invoke_tool', args: { name, args: { action: 'status' } } },
    ])
    const received = Promise.withResolvers<{
      tools: { function: { name: string } }[]
      messages: { role: string; tool_call_id?: string; content: string }[]
    }>()
    let turns = 0
    const provider = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }))
        return
      }
      try {
        const body = JSON.parse(await req.toArray().then(chunks => Buffer.concat(chunks).toString('utf8')))
        const message = ++turns === 1
          ? { role: 'assistant', tool_calls: calls.map((call, i) => ({ id: `call_${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
          : { role: 'assistant', content: 'Finished.' }
        if (turns === 2) received.resolve(body)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message }] }))
      } catch (error) {
        received.reject(error)
        res.writeHead(500).end()
      }
    }).listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const providerAddress = provider.address()
    assert(providerAddress && typeof providerAddress !== 'string')
    const reservation = reservePort().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const credential = randomUUID()
    try {
      const runtime = await startMainRuntime(ConfigSchema.parse({
        agent: { workspace: join(root, 'home'), model: 'deepseek-chat@deepseek', thinking: { type: 'disabled' } },
        providers: { deepseek: { apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` } },
        channels: {}, mcp: {},
      }), { gateway: { host: '127.0.0.1', port: address.port, launchCredential: credential } })
      try {
        await runtime.ready
        const response = await fetch(`http://127.0.0.1:${address.port}/projects/default/api/chat/send`, {
          method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: 'audio-tool-retirement', content: 'Check the retired audio tools.', stream: false }),
          signal: AbortSignal.timeout(6000),
        })
        assert(response.ok, await response.text())
        const body = await Promise.race([received.promise, new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Fixture did not receive tool results')), 8000).unref()
        })])
        assert.ok(body.tools.some(tool => tool.function.name === 'invoke_tool'))
        for (const name of names) assert.ok(!body.tools.some(tool => tool.function.name === name), name)
        for (const [i, call] of calls.entries()) {
          const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === `call_${i}`)
          assert.ok(result, JSON.stringify(call))
          assert.match(result.content, call.name === 'read' ? /Unknown or unavailable tool metadata path/ : /not active and could not be imported|not found|unknown/i, JSON.stringify(call))
        }
      } finally { await runtime.shutdown() }
    } finally { await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) }
  })
})
