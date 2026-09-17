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

/** Shared parser for MCP files and inline installation documents. */
export function parseMcpConfigDocument(
  input: unknown,
  options: { name?: string; defaultName?: string; server?: string } = {},
): McpServerConfig[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MCP config must be an object')
  if ('mcpServers' in input) {
    if (options.name !== undefined) throw new TypeError('name cannot rename an mcpServers map; use its keys and optional server selection')
    if (!input.mcpServers || typeof input.mcpServers !== 'object' || Array.isArray(input.mcpServers)) {
      throw new TypeError('mcpServers must be an object')
    }
    const entries = Object.entries(input.mcpServers)
    if (!entries.length) throw new TypeError('mcpServers is empty')
    if (options.server !== undefined && !entries.some(([name]) => name === options.server)) {
      throw new TypeError('Selected MCP server does not exist in this config')
    }
    return entries.filter(([name]) => options.server === undefined || name === options.server)
      .map(([name, config]) => parseMcpServerConfig(name, config))
  }
  const name = options.name ?? ('name' in input && typeof input.name === 'string' ? input.name : options.defaultName)
  if (!name) throw new TypeError('name is required for a single inline MCP config')
  if (options.server !== undefined && options.server !== name) throw new TypeError('Selected MCP server does not match this config')
  return [parseMcpServerConfig(name, input)]
}
