import { z } from 'zod'
import { A2aConfigSchema, a2aProjectPath } from '../config.ts'
import { absolutePath } from '../cli-support.ts'

const toolNames = z.array(z.enum(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit'])).max(64).default([])
export const CodingBridgeConfigSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  stateDirectory: absolutePath,
  cwd: absolutePath,
  // Zero is a configured-but-unallocated local listener, persisted before first start.
  port: z.number().int().min(0).max(65535).refine(port => port === 0 || port >= 1024, 'Port must be zero (unallocated) or an unprivileged listener port.'),
  server: A2aConfigSchema.shape.server.unwrap().omit({ agentType: true }).extend({
    maxConcurrent: z.number().int().min(1).max(32).default(1),
  }),
  backend: z.discriminatedUnion('type', [
    z.object({ type: z.literal('claude'), tools: toolNames }).strict(),
    z.object({ type: z.literal('codex'), sandbox: z.enum(['read-only', 'workspace-write']).default('read-only') }).strict(),
    z.object({ type: z.literal('copilot'), tools: toolNames }).strict(),
  ]),
  executable: absolutePath.optional(),
  model: z.string().min(1).max(128).optional(),
  environment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(64).default([]),
}).strict().superRefine((value, ctx) => {
  if (new URL(value.server.url).pathname !== a2aProjectPath(value.projectId)) {
    ctx.addIssue({ code: 'custom', path: ['server', 'url'], message: 'URL must select this Project A2A endpoint.' })
  }
})
export type CodingBridgeConfig = z.infer<typeof CodingBridgeConfigSchema>

export function bridgeEnvironment(names: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', ...names]) {
    const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name
    const value = process.env[key]
    if (value !== undefined) env[name] = value
    else if (names.includes(name)) throw new Error(`Missing coding agent environment variable: ${name}`)
  }
  return env
}
