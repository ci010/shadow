import { z } from 'zod'
import type { McpServerConfig } from '../config/schema.ts'

const TransportSchema = z.enum(['stdio', 'sse', 'streamable-http'])
const ServerNameSchema = z.string().min(1).refine(
  (name) => name.trim() === name && !/\s/.test(name) && !name.includes('__'),
  'MCP server names must not contain whitespace or the "__" namespace delimiter',
)

const ServerConfigSchema = z.object({
  name: ServerNameSchema.optional(),
  type: TransportSchema.optional(),
  transport: TransportSchema.optional(),
  command: z.string().refine((value) => value.trim().length > 0, 'Command must not be blank').optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().refine(
    (value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol),
    'MCP URL must use http or https',
  ).optional(),
  headers: z.record(z.string()).optional(),
  description: z.string().optional(),
}).superRefine((config, ctx) => {
  if (config.type && config.transport && config.type !== config.transport) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transport'], message: 'Conflicting MCP type and transport' })
  }
  const transport = config.transport ?? config.type ?? 'stdio'
  if (transport === 'stdio' && !config.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'Stdio transport requires a command' })
  }
  if (transport !== 'stdio' && !config.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'HTTP transport requires a URL' })
  }
})

/** Normalize imported and main-config entries without retaining private fields. */
export function parseMcpServerConfig(name: string, input: unknown): McpServerConfig {
  ServerNameSchema.parse(name)
  const config = ServerConfigSchema.parse(input)
  if (config.name !== undefined && config.name !== name) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['name'],
      message: 'MCP server name must match its record key',
    }])
  }
  const { type, transport, name: _name, ...options } = config
  return { name, transport: transport ?? type ?? 'stdio', ...options }
}
