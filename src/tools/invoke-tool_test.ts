import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ImportTool } from './load-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import type { Tool, ToolParameters } from './tool.ts'

class DynamicEchoTool implements Tool {
  readonly name = 'dynamic_echo'
  readonly description = 'Echo a value.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return String(args.value)
  }
}

test('invoke_tool executes active dynamic tools without exposing them', async () => {
  const base = new Tools('/workspace')
  const session = new SessionTools(base, '/workspace')
  session.registerDynamic(new DynamicEchoTool())
  const context = { tools: session } as ExecutionContext

  assertEquals(session.getDefinitions(), [])
  assert((await session.execute('dynamic_echo', { value: 'hidden' }, context))
    .includes('unknown tool "dynamic_echo"'))
  assertEquals(
    await new InvokeTool().execute(
      { name: 'dynamic_echo', args: { value: 'through gateway' } },
      context,
    ),
    'through gateway',
  )

  const loadable = new Map([['dynamic_echo', new DynamicEchoTool()]])
  const importer = new ImportTool(loadable, '/workspace')
  const loadedSession = new SessionTools(base, '/workspace')
  const contract = await importer.importSource(
    { source: 'v:tools/dynamic_echo' },
    loadedSession,
  )
  assert(contract.includes('invoke_tool({ name, args })'))
  assert(contract.includes('"name":"dynamic_echo"'))
  assert(contract.includes('"properties":{"value":{"type":"string"}}'))

  const lazySession = new SessionTools(base, '/workspace')
  assertEquals(
    await new InvokeTool(importer).execute(
      { name: 'dynamic_echo', args: { value: 'lazy first invoke' } },
      { tools: lazySession } as ExecutionContext,
    ),
    'lazy first invoke',
  )

  const restrictedSession = new SessionTools(
    base,
    '/workspace',
    ['invoke_tool'],
  )
  restrictedSession.registerDynamic(new DynamicEchoTool())
  assertEquals(
    await new InvokeTool().execute(
      { name: 'dynamic_echo', args: { value: 'allowed through gateway' } },
      { tools: restrictedSession } as ExecutionContext,
    ),
    'allowed through gateway',
  )

  const blockedSession = new SessionTools(
    base,
    '/workspace',
    undefined,
    ['dynamic_echo'],
  )
  blockedSession.registerDynamic(new DynamicEchoTool())
  assert(
    (await new InvokeTool().execute(
      { name: 'dynamic_echo', args: { value: 'blocked' } },
      { tools: blockedSession } as ExecutionContext,
    )).includes('not available for this agent type'),
  )
})