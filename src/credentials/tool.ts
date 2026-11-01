import { z } from 'zod'
import type { Tool } from '../tools/tool.ts'
import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import type { CredentialRequests } from './requests.ts'

const input = z.object({
  secretRef: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  purpose: z.string().trim().min(1).max(500),
}).strict()

/** Private Web interaction only. A saved secret is not a grant or deployment approval. */
export function credentialRequestTool(options: {
  projectId: string
  requests: CredentialRequests
  canManage: (sessionId: string) => boolean
}): Tool {
  return {
    name: 'credential_request', optIn: true,
    description: 'Request private credential entry in this Project owner Web conversation. Supply only a reference name and purpose, never a credential value. Returns saved/cancelled status, not a secret. Does not grant capabilities or deploy a BOT.',
    parameters: { type: 'object', properties: { secretRef: { type: 'string' }, purpose: { type: 'string' } }, required: ['secretRef', 'purpose'], additionalProperties: false },
    execute: async (args, context) => {
      context.signal.throwIfAborted()
      if (!isDirectOwnerTurn(context) || context.projectId !== options.projectId || context.remoteWorkdir || !options.canManage(context.sessionId)) {
        throw new Error('Private credential entry requires a direct owner turn in a local durable administrator Web session in this Project.')
      }
      const parsed = input.parse(args)
      return JSON.stringify(await options.requests.request({ name: parsed.secretRef, purpose: parsed.purpose }, context.signal, context.sessionId))
    },
  }
}
