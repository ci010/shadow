import { z } from 'zod'

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)
export const A2aUrlSchema = z.string().url().max(2048).refine(value => {
  const url = new URL(value)
  return !url.username && !url.password && !url.hash && !url.search &&
    (url.protocol === 'https:' || url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname))
}, 'A2A requires HTTPS, or HTTP on an explicit loopback IP, without credentials, query or fragment.')
  .transform(value => new URL(value).href)

export const A2aConfigSchema = z.object({
  server: z.object({
    url: A2aUrlSchema,
    agentType: name,
    callers: z.record(name, environmentName).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 32),
    maxConcurrent: z.number().int().min(1).max(32).default(4),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  }).strict().optional(),
  agents: z.record(name, z.object({
    cardUrl: A2aUrlSchema,
    endpointUrl: A2aUrlSchema,
    tokenEnv: environmentName.optional(),
  }).strict()).default({}),
}).strict()
export type A2aConfig = z.infer<typeof A2aConfigSchema>

export class A2aConfigurationError extends Error {}

export function resolveA2aSecret(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name]
  if (!value || value.length < 32 || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new A2aConfigurationError(`A2A credential ${name} must contain 32-4096 non-whitespace characters.`)
  }
  return value
}

export function a2aProjectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/a2a`
}

/** This is only the host-auth exception; the project route always authenticates again. */
export function a2aRequestProject(request: Request): string | undefined {
  const path = new URL(request.url).pathname
  const match = /^\/projects\/([A-Za-z0-9_-]+)\/a2a(\/\.well-known\/agent-card\.json)?$/.exec(path)
  if (!match || (match[2] ? request.method !== 'GET' : request.method !== 'POST')) return
  return match[1]
}
