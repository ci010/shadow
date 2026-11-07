import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { executeBotTool, type ExecuteBotToolOptions } from './tool-runtime.ts'
import { botFiles } from './sdk-test-fixture.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { conversationBindingKey } from './contracts.ts'
import { channelSessionId } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotHostScope } from './host-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

const source = (body: string) => `import { defineTool } from '@shadow/bot-sdk'; export default defineTool({ async execute(args, ctx) { ${body} } });`
const options = (body: string, extra: Partial<ExecuteBotToolOptions> = {}): ExecuteBotToolOptions => ({
  files: botFiles(source(body)), tool: 'custom_tool', args: { text: 'data' },
  signal: new AbortController().signal, allowedTools: ['custom_tool'], authorize: () => {}, ...extra,
})

test('SDK host capabilities are absent by default; each unapproved operation fails before host callback', async () => {
  for (const operation of ['wake', 'watermark', 'messages', 'work', 'send']) {
    let calls = 0
    const host = async () => { calls++; return { ok: true } }
    await assert.rejects(executeBotTool(options(`return ctx.${operation}.call({})`, { host })))
    const files = botFiles(source(`return ctx.${operation}.call({})`), { hostCapabilities: ['work'] })
    if (operation !== 'work') await assert.rejects(executeBotTool(options('', { files, host })))
    assert.equal(calls, 0, operation)
  }
})

test('approved SDK host operations pass data, reauthorize each callback and grant no implicit send', async () => {
  let checks = 0
  const calls: unknown[] = []
  const files = botFiles(source(`
    const result = [];
    for (const name of ['wake', 'watermark', 'messages', 'work', 'send']) result.push(await ctx[name].call({text: args.text}));
    return result;
  `), { hostCapabilities: ['wake', 'watermark', 'messages', 'work', 'send'] })
  const result = await executeBotTool(options('', { files, authorize: () => { checks++ },
    host: async (name, input, signal) => { signal.throwIfAborted(); calls.push([name, input]); return { name } } }))
  assert.deepEqual(result, ['wake', 'watermark', 'messages', 'work', 'send'].map(name => ({ name })))
  assert.deepEqual(calls, ['wake', 'watermark', 'messages', 'work', 'send'].map(name => [name, { text: 'data' }]))
  assert.equal(checks, 7, 'two setup checks plus one check for every host RPC')
})

test('host revocation and cancellation stop subsequent SDK callbacks', async () => {
  let allowed = true, calls = 0
  const files = botFiles(source(`await ctx.work.call({}); return ctx.send.call({});`), { hostCapabilities: ['work', 'send'] })
  await assert.rejects(executeBotTool(options('', { files,
    authorize: () => { if (!allowed) throw new Error('revoked') },
    host: async () => { calls++; allowed = false; return null } })))
  assert.equal(calls, 1)
  const controller = new AbortController()
  let callbackSignal: AbortSignal | undefined
  const pending = executeBotTool(options('', { files, signal: controller.signal,
    host: async (_name, _input, signal) => { callbackSignal = signal; controller.abort(); return await new Promise(() => {}) } }))
  await assert.rejects(pending, /abort/i)
  assert.equal(callbackSignal?.aborted, true)
})

test('DirectoryBots derives host scope from real bounded deployment; guest scope/destination fields cannot grant authority', async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'project', folderId = randomUUID()
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'bots'), runGit: async () => { throw new Error('bounded only') } })
    const bots = new DirectoryBots(deployments)
    const address = { projectId, botInstanceId: 'connection', platform: 'qq' as const, conversationId: 'group:one' }
    const second = { ...address, conversationId: 'group:two' }
    const binding = (value: typeof address, enabled = true) => ({ platform: value.platform, botInstanceId: value.botInstanceId, conversationId: value.conversationId, enabled, tools: ['custom_tool'] })
    const deploy = async (enabled = true, subscribed = true) => {
      const files = botFiles(source('return ctx.work.call(args)'), {
        hostCapabilities: ['work'],
        tools: [{ name: 'custom_tool', description: 'Work intake', parameters: { type: 'object' }, module: 'tools/main.ts', imports: [] }],
        bindings: [binding(address, enabled), binding(second)],
        ...(subscribed ? {} : { subscriptions: [{ platform: second.platform, botInstanceId: second.botInstanceId, conversationId: second.conversationId }] }),
      })
      const frozen = deployments.freeze(files)
      await deployments.deploy({ id: 'demo', source: { folderId, directory: '' }, ...frozen, expectedRevision: deployments.read('demo')?.deployment.revision })
      return deployments.read('demo')!.deployment.revision
    }
    const revision = await deploy()
    const sessionId = channelSessionId(address)
    const context = { projectId, sessionId, channelAddress: address, messageId: 'source-input', signal: new AbortController().signal } as ExecutionContext
    const scopes: BotHostScope[] = []
    let effects = 0
    bots.setHostOperations(async (scope, operation, input, ctx) => {
      scopes.push(scope)
      assert.equal(operation, 'work'); assert.equal(ctx.sessionId, sessionId)
      const parsed = z.object({ action: z.literal('query') }).strict().parse(input)
      effects++
      return parsed
    })
    assert.deepEqual(await bots.execute('demo', revision, ['custom_tool'], 'custom_tool', { action: 'query' }, context), { action: 'query' })
    const scope = scopes[0]!
    assert.deepEqual(scope, { projectId, botId: 'demo', revision, bindingKey: conversationBindingKey(address), sessionId, address })
    for (const forbidden of [{ destination: 'group:two' }, { projectId: 'other' }, { sessionId: 'owner-web' }, { workspace: '/private' }]) {
      await assert.rejects(bots.execute('demo', revision, ['custom_tool'], 'custom_tool', { action: 'query', ...forbidden }, context))
      assert.deepEqual(scopes.at(-1), scope, 'guest input never overrides the host-owned scope')
    }
    assert.equal(effects, 1, 'strict mock host rejects guest selectors before mutation')
    for (const invalid of [
      { ...scope, projectId: 'foreign' }, { ...scope, address: { ...scope.address, projectId: 'foreign' } },
      { ...scope, revision: 'stale' }, { ...scope, bindingKey: 'not-this-binding' },
      { ...scope, address: { ...scope.address, conversationId: second.conversationId } },
    ]) assert.throws(() => bots.assertHostScope(invalid, 'work'))
    assert.throws(() => bots.assertHostScope(scope, 'send'), /capability/)
    await deploy(false)
    assert.throws(() => bots.assertHostScope(scope, 'work'), /changed|unavailable/)
    await assert.rejects(bots.execute('demo', revision, ['custom_tool'], 'custom_tool', { action: 'query' }, context), /changed/)
    const disabled = { ...scope, revision: deployments.read('demo')!.deployment.revision }
    assert.throws(() => bots.assertHostScope(disabled, 'work'), /binding/)
    const unsubscribedRevision = await deploy(true, false)
    assert.throws(() => bots.assertHostScope({ ...scope, revision: unsubscribedRevision }, 'work'), /binding/)
    assert.equal(effects, 1)
  })
})
