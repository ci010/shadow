import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { CapabilityError, type CapabilityBroker, type HttpFailureDiagnostics } from './capabilities.ts'
import { conversationBindingKey, type CapabilityGrant, type ResolvedConversationPolicy } from './contracts.ts'
import { executeAuthoredTool } from './tool-runtime.ts'
import { isOwnerAuthoring, validateToolArguments } from './service.ts'

export type ProbeTarget = 'draft' | 'candidate' | 'published'

interface ProbeDependencies {
  projectId: string
  resolve: (sessionId: string, target: ProbeTarget) => ResolvedConversationPolicy | undefined
  assertCurrent: (policy: ResolvedConversationPolicy, sessionId: string, target: ProbeTarget) => void
  broker: Pick<CapabilityBroker, 'execute'>
}

interface ProbeCall {
  capability: string
  method: string
  path: string
  phase: 'authorization' | 'credential' | 'transport' | 'response'
  outcome: 'pending' | 'succeeded' | 'failed' | 'denied'
  requestAttempted: boolean
  responseReceived: boolean
  httpStatus?: number
  errorCode?: string
  diagnostics?: HttpFailureDiagnostics
}

export async function probeTool(
  dependencies: ProbeDependencies,
  input: { address: ChannelAddress; target: ProbeTarget; revision?: string; toolName: string; args: Record<string, unknown> },
  context: Parameters<typeof isOwnerAuthoring>[0] & Pick<ExecutionContext, 'projectId' | 'signal' | 'messageId' | 'toolCallId'>,
) {
  if (!isOwnerAuthoring(context) || context.projectId !== dependencies.projectId || input.address.projectId !== dependencies.projectId) {
    throw new Error('A live read-only probe requires a direct administrator Web turn in this Project.')
  }
  context.signal.throwIfAborted()
  const sessionId = channelSessionId(input.address)
  const policy = dependencies.resolve(sessionId, input.target)
  if (!policy?.binding.enabled || input.revision !== undefined && policy.revision !== input.revision) {
    throw new Error(`Choose an enabled ${input.target} binding and its exact revision. Probe never falls back to a published version.`)
  }
  const authority = input.target === 'published' ? policy : dependencies.resolve(sessionId, 'published')
  if (!authority?.binding.enabled) {
    throw new Error('No approved service binding exists for this conversation. This probe reuses existing GET grants; it cannot approve new access or publish code.')
  }
  return executeProbe({
    broker: dependencies.broker, policy, authority, grantsEqual: isDeepStrictEqual,
    assertCurrent: () => {
      dependencies.assertCurrent(policy, sessionId, input.target)
      if (authority !== policy) dependencies.assertCurrent(authority, sessionId, 'published')
    },
  }, input, context)
}

export function readOnlyGrants(policy: ResolvedConversationPolicy, toolName: string) {
  const tool = policy.tools.find(tool => tool.name === toolName)
  if (!tool || !policy.agent.allowedTools?.includes(toolName)) throw new Error('Choose a selected, allowed tool.')
  return policy.binding.grants.flatMap(grant => {
    if (grant.kind !== 'http' || !tool.imports.includes(`@shadow/${grant.id}`)) return []
    const routes = grant.routes.filter(route => route.method === 'GET').map(route => ({ method: 'GET' as const, path: route.path }))
    return routes.length ? [{ ...grant, routes }] : []
  })
}

/** Called only after the owner decision endpoint consumes a pinned, one-use request. */
export async function probeApprovedTool(
  dependencies: {
    broker: Pick<CapabilityBroker, 'execute'>
    policy: ResolvedConversationPolicy
    approvalId: string
    maxCalls: number
    assertCurrent: () => void
  },
  input: { toolName: string; args: Record<string, unknown> },
  context: Pick<ExecutionContext, 'sessionId' | 'signal' | 'messageId' | 'toolCallId'>,
) {
  const grants = readOnlyGrants(dependencies.policy, input.toolName)
  const authority = {
    ...dependencies.policy,
    revision: `approval:${dependencies.approvalId}`,
    binding: { ...dependencies.policy.binding, grants },
  }
  return executeProbe({
    ...dependencies, authority,
    grantsEqual: (grant, approved) => grant.kind === 'http' && isDeepStrictEqual(
      { ...grant, routes: grant.routes.filter(route => route.method === 'GET').map(({ path }) => ({ method: 'GET', path })) },
      approved,
    ),
  }, { ...input, target: 'candidate' }, context)
}

async function executeProbe(
  dependencies: {
    broker: Pick<CapabilityBroker, 'execute'>
    policy: ResolvedConversationPolicy
    authority: ResolvedConversationPolicy
    grantsEqual: (grant: CapabilityGrant, approved: CapabilityGrant) => boolean
    assertCurrent: () => void
    maxCalls?: number
  },
  input: { target: ProbeTarget; toolName: string; args: Record<string, unknown> },
  context: Pick<ExecutionContext, 'sessionId' | 'signal' | 'messageId' | 'toolCallId'>,
) {
  const { policy, authority } = dependencies
  const tool = policy.tools.find(tool => tool.name === input.toolName)
  if (!tool || !policy.agent.allowedTools?.includes(tool.name)) throw new Error(`The ${input.target} binding does not allow this tool.`)
  validateToolArguments(tool.parameters, input.args)
  const calls: ProbeCall[] = []
  let denied: CapabilityError | undefined
  const assertCurrent = () => {
    context.signal.throwIfAborted()
    dependencies.assertCurrent()
  }
  assertCurrent()
  let result: unknown
  let failure: { code: string; httpStatus?: number } | undefined
  try {
    result = await executeAuthoredTool({
      code: tool.code, args: input.args, signal: context.signal,
      filename: tool.source, imports: tool.imports, allowedModules: policy.agent.allowedModules, mode: 'probe',
      callModule: async (name, input, signal) => {
        assertCurrent()
        const call: ProbeCall = {
          capability: name, method: typeof input.method === 'string' ? input.method.slice(0,16) : '',
          path: typeof input.path === 'string' ? input.path.slice(0,1024) : '',
          phase: 'authorization', outcome: 'pending', requestAttempted: false, responseReceived: false,
        }
        calls.push(call)
        const deny = (code: string, message: string): never => {
          call.outcome = 'denied'
          call.errorCode = code
          denied = new CapabilityError(code, message)
          throw denied
        }
        const grant = policy.binding.grants.find(grant => grant.id === name)
        const approved = authority.binding.grants.find(grant => grant.id === name)
        if (dependencies.maxCalls !== undefined && calls.length > dependencies.maxCalls) return deny('call_budget_exceeded', 'The approved request call budget is exhausted.')
        if (!tool.imports.includes(`@shadow/${name}`) || !grant) return deny('capability_denied', 'Probe requested an undeclared or ungranted module.')
        if (grant.kind !== 'http' || input.method !== 'GET') return deny('route_denied', 'Probes permit only HTTP GET, never writes or inbox delivery.')
        if (!approved || !dependencies.grantsEqual(grant, approved)) {
          return deny('grant_not_approved', 'Probe can reuse only unchanged approved service grants, not draft permission changes.')
        }
        try {
          const output = await dependencies.broker.execute(approved, input, {
            sessionId: context.sessionId, inputId: context.messageId, toolCallId: context.toolCallId ?? context.messageId,
            bindingKey: conversationBindingKey(authority.binding), revision: authority.revision,
            signal, assertCurrent,
            onHttpProgress: event => {
              if (event.stage === 'request') { call.requestAttempted = true; call.phase = 'transport' }
              else { call.responseReceived = true; call.httpStatus = event.status; call.phase = 'response' }
            },
          })
          assertCurrent()
          call.outcome = 'succeeded'
          return output
        } catch (error) {
          call.outcome = 'failed'
          call.errorCode = error instanceof CapabilityError ? error.code : 'capability_failed'
          if (error instanceof CapabilityError && error.status !== undefined) call.httpStatus = error.status
          if (error instanceof CapabilityError && error.diagnostics) call.diagnostics = error.diagnostics
          if (['unknown_secret', 'secret_unavailable', 'invalid_secret'].includes(call.errorCode)) call.phase = 'credential'
          throw error
        }
      },
    })
  } catch (error) {
    assertCurrent()
    failure = error instanceof CapabilityError
      ? { code: error.code, ...(error.status !== undefined ? { httpStatus: error.status } : {}) }
      : { code: 'execution_failed' }
  }
  assertCurrent()
  const failedCall = calls.find(call => call.outcome === 'failed' || call.outcome === 'denied')
  if (denied) failure = { code: denied.code }
  else if (failedCall) failure = { code: failedCall.errorCode!, ...(failedCall.httpStatus !== undefined ? { httpStatus: failedCall.httpStatus } : {}) }
  if (failure) console.warn('[authoring-probe] Failed', { target: input.target, revision: policy.revision, toolName: tool.name, ...failure })
  return {
    target: input.target, revision: policy.revision, authorizationRevision: authority.revision,
    toolName: tool.name, source: tool.source, synthetic: false, mode: `${input.target}-http-get-only`,
    sourceHash: `sha256:${createHash('sha256').update(tool.code).digest('hex')}`,
    policy: { kind: 'restricted', mode: 'probe', imports: tool.imports, allowedModules: policy.agent.allowedModules ?? [] },
    execution: failure ? 'failed' : 'completed', ...(failure ? { error: failure } : {}),
    httpVerified: calls.some(call => call.outcome === 'succeeded' && call.responseReceived),
    calls, result,
    limitation: 'Only recorded GET branches were exercised. A transport attempt does not prove the server received a request. No publication, bot turn, write or inbox delivery occurs; script output is not an assertion of business success.',
  }
}
