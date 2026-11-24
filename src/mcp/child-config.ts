import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { managedBrowserNames } from '../browser/managed-browsers.ts'
import { isAbsolute } from 'node:path'
import { McpSchema } from '../config/schema.ts'

const document = z.array(z.object({
  pairingId: z.string().min(1),
  projectScope: z.string().regex(/^[a-f0-9]{32}$/),
  workdirId: z.string().min(1),
  sources: McpSchema,
  desktop: z.literal(true).optional(),
  browser: z.object({ browser: z.enum(managedBrowserNames), executablePath: z.string().refine(isAbsolute),
    userDataDir: z.string().refine(isAbsolute), profileDirectory: z.string().regex(/^(Default|Profile [0-9]+)$/), }).strict().optional(),
}).strict())

/** This document is provisioned locally by the Child operator, never by Main RPC. */
export async function readChildMcpConfig(path: string) {
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  try { return document.parse(JSON.parse(raw)) }
  catch { throw new Error('Invalid Child MCP configuration') }
}

export function resolveChildMcpSource(
  grants: Awaited<ReturnType<typeof readChildMcpConfig>>,
  pairingId: string,
  request: { projectScope?: string; workdirId?: string },
  source: string,
  workdirs: readonly { workdirId: string; rootPath: string }[],
) {
  const workdir = workdirs.find(binding => binding.workdirId === request.workdirId)
  const matches = grants.filter(grant => grant.pairingId === pairingId && grant.projectScope === request.projectScope && grant.workdirId === request.workdirId)
    .flatMap(grant => grant.sources.servers.filter(server => server.name === source))
  if (!workdir || matches.length !== 1) throw new Error('Child MCP source not granted')
  return { config: matches[0], cwd: workdir.rootPath }
}

/** Managed grants must be unambiguous and target a static registered directory. */
export function resolveChildManagedMcpGrant(
  grants: Awaited<ReturnType<typeof readChildMcpConfig>>,
  pairingId: string,
  request: { projectScope?: string; workdirId?: string },
  source: 'chrome-devtools' | 'agent-desktop',
  workdirs: readonly { workdirId: string; rootPath: string }[],
) {
  const workdir = workdirs.find(binding => binding.workdirId === request.workdirId)
  const matches = grants.filter(grant => grant.pairingId === pairingId && grant.projectScope === request.projectScope && grant.workdirId === request.workdirId)
  const grant = matches.length === 1 ? matches[0] : undefined
  if (!workdir || !(source === 'chrome-devtools' ? grant?.browser : grant?.desktop)) throw new Error('Child managed source not granted')
  return { grant: grant!, cwd: workdir.rootPath }
}
