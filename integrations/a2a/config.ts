import { z } from 'zod'
import { A2aConfigSchema, a2aProjectPath } from '../../src/a2a/config.ts'
import { absolutePath } from '../../src/a2a/cli-support.ts'

const toolNames = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(64).default([])
export const CodingBridgeConfigSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  stateDirectory: absolutePath,
  cwd: absolutePath,
  port: z.number().int().min(1024).max(65535),
  server: A2aConfigSchema.shape.server.unwrap().omit({ agentType: true }).extend({
    maxConcurrent: z.number().int().min(1).max(32).default(1),
  }),
  backend: z.discriminatedUnion('type', [
    z.object({ type: z.literal('claude'), tools: toolNames }).strict(),
    z.object({ type: z.literal('codex'), sandbox: z.enum(['read-only', 'workspace-write']).default('read-only') }).strict(),
    z.object({ type: z.literal('copilot'), tools: toolNames }).strict(),
  ]),
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
    const value = process.env[name]
    if (value !== undefined) env[name] = value
    else if (names.includes(name)) throw new Error(`Missing coding agent environment variable: ${name}`)
  }
  return env
}
