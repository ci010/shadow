import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import { parseAgentFile } from './parse.ts'
import type { AgentTypeDefinition } from './types.ts'

const BUILTIN_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  './builtin',
)

export async function getBuiltinAgentTypes(): Promise<AgentTypeDefinition[]> {
  const types: AgentTypeDefinition[] = []
  for (const entry of await readdir(BUILTIN_AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const agentDir = join(BUILTIN_AGENTS_DIR, entry.name)
    const filePath = join(agentDir, 'AGENT.md')
    const content = await readFile(filePath, 'utf8')
    const def = parseAgentFile(content, entry.name, agentDir)
    def.source = 'builtin'
    types.push(def)
  }
  return types
}
