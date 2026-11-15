import { z } from 'zod'
import { resourceSchema } from './resources.ts'
import { installationSchema } from './managed.ts'
import { validateFSInput } from '../../tools/layerfs-fs.ts'
import { validateLayerArgs } from '../../tools/layerfs.ts'
import { parseBranchWorkspace } from './workspace-identity.ts'
import type { RemoteLayerFSCall } from './remote-contract.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'
const text = z.string().min(1).max(2000).regex(/^[^\x00-\x1f\x7f]+$/)
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const branch = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/).refine(v => !v.split('/').includes('..'))
const reference = z.object({ sessionId: text, physicalId: text, requestId: text }).strict()
const workspace = z.string().min(1).max(2048)
const create = { source: text, branch: branch.optional(), idempotencyKey: text.optional(), description: z.string().max(2000).optional(), name: name.optional() }
const schemas: Partial<Record<RemoteLayerFSCall['action'], z.ZodTypeAny>> = {
  contexts_revoke: z.object({}).strict(),
  doctor: z.object({}).strict(), bootstrap_status: z.object({}).strict(), resource_list: z.object({}).strict(),
  setup_plan: z.object({ installation: installationSchema }).strict(),
  setup: z.object({ plan: text, approval: reference, approved: z.literal(true), allowRootWorker: z.literal(true) }).strict(),
  bootstrap_plan: z.object({ distribution: name.optional() }).strict(),
  bootstrap: z.object({ plan: text, approval: reference, approved: z.literal(true), allowRootWorker: z.literal(true), allowDownloads: z.literal(true) }).strict(),
  bootstrap_cancel: z.object({ targetJobId: z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/) }).strict(),
  bootstrap_reconcile: z.object({ targetJobId: z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/) }).strict(),
  runtime_plan: z.object({ runtimeId: name }).strict(), runtime_start: z.object({ runtimeId: name }).strict(), runtime_status: z.object({ runtimeId: name }).strict(),
  runtime_context: z.object({ runtimeId: name, sourceName: name.optional() }).strict(),
  resource_register: resourceSchema, resource_inspect: z.object({ resourceId: z.string().uuid() }).strict(),
  workspace_create: z.object({ ...create, source: z.string().uuid() }).strict(), workspace_fork: z.object({ ...create, source: branch, sourceBinding: workspace }).strict(),
  reconcile: z.object({ requestId: z.string().uuid() }).strict(),
  read: z.object({ workspace, path: text, start: z.number().int().positive().optional(), end: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict(),
  write: z.object({ workspace, path: text, content: z.string(), match: z.string().min(1).optional() }).strict(),
  search: z.object({ workspace, path: text, handler: z.enum(['grep', 'glob']), query: text, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  exec: z.object({ workspace, command: z.string().min(1).max(65536).refine(v => !v.includes('\0')), captureLimit: z.number().int().min(1).max(8388608).optional() }).strict(),
  status: z.object({ workspace }).strict(),
  branches: z.object({ workspace, offset: z.number().int().nonnegative().optional() }).strict(),
  history: z.object({ workspace, offset: z.number().int().nonnegative().optional() }).strict(),
  diff_commits: z.object({ workspace, ref: z.string().regex(/^(?:[a-f0-9]{2})+$/), branch: z.string().regex(/^(?:[a-f0-9]{2})+$/), offset: z.number().int().nonnegative().optional() }).strict(),
}
/** Pure request validation runs before target journal admission or any service construction. */
export function validateRemoteLayerFSInput(call: RemoteLayerFSCall): void {
  const schema = schemas[call.action]
  if (schema) {
    schema.parse(call.input)
    if (['read', 'write', 'search', 'exec', 'status'].includes(call.action)) validateLayerArgs({ ...call.input, action: call.action }, call.authority.projectScope)
  }
  else if (['mkdir', 'rm', 'cp', 'mv', 'apply', 'diff_files', 'blame'].includes(call.action)) validateFSInput(call.action, call.input)
  else if (['read', 'write', 'search', 'exec', 'status'].includes(call.action)) validateLayerArgs({ ...call.input, action: call.action }, call.authority.projectScope)
  else throw new ToolNoEffectError('Unsupported typed LayerFS input')
  const branchOperation = ['read', 'write', 'search', 'exec', 'status', 'mkdir', 'rm', 'cp', 'mv', 'apply', 'diff_files', 'blame', 'branches', 'history', 'diff_commits'].includes(call.action)
  if (branchOperation && typeof call.input.workspace !== 'string') throw new ToolNoEffectError('Registered LayerFS workspace required')
  const bound = call.input.workspace ?? call.input.sourceBinding
  if (bound !== undefined) {
    if (typeof bound !== 'string') throw new ToolNoEffectError('Exact registered LayerFS workspace required')
    const binding = parseBranchWorkspace(bound)
    if (binding.version !== 3 || binding.ownerProject !== call.authority.projectScope) throw new ToolNoEffectError('LayerFS workspace belongs to another Project')
    if (binding.branch === 'main' && ['write', 'exec', 'mkdir', 'rm', 'cp', 'mv', 'apply'].includes(call.action)) throw new ToolNoEffectError('main is readonly; fork a branch')
    if (call.action === 'workspace_fork' && binding.branch !== call.input.source) throw new ToolNoEffectError('LayerFS source branch mismatch')
  }
}
