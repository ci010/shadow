import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseMcpConfigDocument } from './config.ts'
import type { McpServerConfig } from '../config/schema.ts'

export interface FolderMcpSource { config: McpServerConfig; cwd: string; declaration: string }
/** Explicit conventions only. Discovery never connects or interpolates credentials. */
export async function discoverFolderMcp(folder: { id: string; path: string }): Promise<FolderMcpSource[]> {
  const sources: FolderMcpSource[] = []
  for (const file of ['.mcp.json', '.vscode/mcp.json']) {
    const declaration = join(folder.path, file)
    let text: string
    try {
      if ((await stat(declaration)).size > 128_000) throw new Error('oversize')
      text = await readFile(declaration, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Cannot read folder MCP declaration ${file}; check access and the 128000-byte limit.`)
    }
    try {
      let input = JSON.parse(text)
      if (file === '.vscode/mcp.json') {
        if (!input || typeof input !== 'object' || !input.servers || typeof input.servers !== 'object' || Array.isArray(input.servers)) throw new Error('servers required')
        input = { mcpServers: Object.fromEntries(Object.entries(input.servers).map(([name, value]) => {
          const config = value as Record<string, unknown>
          return [name, { ...config, ...(config.type === 'http' ? { type: 'streamable-http' } : {}) }]
        })) }
      }
      if (!input || typeof input !== 'object' || !('mcpServers' in input)) throw new Error('mcpServers required')
      for (const config of parseMcpConfigDocument(input)) {
        if (config.name === 'chrome-devtools' || config.args?.some(arg => arg.includes('chrome-devtools-mcp'))) throw new Error('Use managed browser source')
        // Names cannot collide with Project declarations or another folder/file.
        const scope = createHash('sha256').update(`${folder.id}\0${file}`).digest('hex').slice(0, 16)
        sources.push({ config: { ...config, name: `folder-${scope}-${config.name}` }, cwd: folder.path, declaration: file })
      }
    } catch {
      // Parser diagnostics can contain credential-bearing JSON fragments.
      throw new Error(`Invalid folder MCP declaration ${file}; expected a valid MCP server map. Values and parser diagnostics are withheld.`)
    }
  }
  return sources
}

export function folderMcpSummary(sources: FolderMcpSource[]): string {
  return ['## Folder MCP declarations', ...sources.map(source =>
    `Source: v:tools/${source.config.name}; declaration: ${source.declaration}. Search v:tools for index status; search never connects. If unindexed, call invoke_tool({name: ${JSON.stringify(source.config.name)}, args: {}}) to start the configured service and return contracts without executing a tool; then invoke_tool using a returned exact name.`),
    ...(!sources.length ? ['(No supported folder MCP declarations.)'] : [])].join('\n')
}
