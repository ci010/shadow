import { z } from 'zod'

export const CHILD_MCP_OPERATION = 'workdir.mcp'
export const childMcpArgsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect-browser') }).strict(),
  z.object({ action: z.literal('initialize'), source: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
  z.object({ action: z.literal('call'), binding: z.string().uuid(), tool: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), args: z.record(z.unknown()) }).strict(),
  z.object({ action: z.literal('release'), binding: z.string().uuid() }).strict(),
])
export type ChildMcpArgs = z.infer<typeof childMcpArgsSchema>
export const MAX_CHILD_MCP_RESULT_BYTES = 1024 * 1024
