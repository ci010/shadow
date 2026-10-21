import type { McpServerConfig } from '../config/schema.ts'
import type { McpToolInfo } from '../mcp/client.ts'

/** Reviewed npm release. Upgrades require rechecking routing and connection lifecycle. */
export const CHROME_MCP_PACKAGE = 'chrome-devtools-mcp@1.10.1'
const browserTools = new Set(['list_pages', 'new_page',
  'get_heapsnapshot_summary', 'get_heapsnapshot_details', 'get_heapsnapshot_class_nodes',
  'get_heapsnapshot_retainers', 'close_heapsnapshot', 'get_heapsnapshot_retaining_paths',
  'get_heapsnapshot_edges', 'get_heapsnapshot_dominators', 'compare_heapsnapshots',
  'get_heapsnapshot_duplicate_strings', 'get_heapsnapshot_object_details', 'query_heapsnapshot_objects'])

export function chromeToolAllowed(config: McpServerConfig, tool: McpToolInfo): boolean {
  if (config.name !== 'chrome-devtools') return true
  if (tool.name === 'select_page') return false
  if (browserTools.has(tool.name)) return true
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined
  if (!schema?.properties?.pageId || !schema.required?.includes('pageId')) {
    throw new Error(`Incompatible Chrome tool ${tool.name}: explicit required pageId is missing. No implicit selection fallback is allowed.`)
  }
  return true
}

export function validateChromeCall(config: McpServerConfig, tool: McpToolInfo, args: Record<string, unknown>): void {
  if (config.name !== 'chrome-devtools') return
  if (!chromeToolAllowed(config, tool)) throw new Error('select_page is disabled; pass pageId on every page tool.')
  if (!browserTools.has(tool.name) && (typeof args.pageId !== 'number' || !Number.isSafeInteger(args.pageId) || args.pageId < 0)) {
    throw new Error('An explicit valid integer pageId is required. Use list_pages; never fall back to the selected page.')
  }
}
