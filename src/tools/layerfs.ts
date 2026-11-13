import { layerfsResourceContracts } from './layerfs-resource.ts'
import { parseBranchWorkspace } from '../execution/layerfs/workspace-identity.ts'
import { configuration, LayerFSConfigurationError } from '../execution/layerfs/bridge.ts'
import { managedLayerFS, type ManagedLayerFS } from '../execution/layerfs/managed.ts'
import { assertLayerFSSetupOwner, type LayerFSBootstrap } from '../execution/layerfs/bootstrap.ts'
import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, completedToolFailure, type Tool, type ToolParameters, type ToolResult } from './tool.ts'

const installationIntents = {
  doctor: { description: 'Inspect installation configuration without starting a worker.', required: [], optional: [] },
  setup: { description: 'Connect an existing trusted installation with explicit owner consent; not an installer.', required: ['installation', 'approved', 'allowRootWorker'], optional: [] },
  bootstrap_plan: { description: 'Discover WSL and return the installation approval request without provisioning.', required: [], optional: ['distribution'] },
  bootstrap: { description: 'Build the exact approved pinned installation. Wait for background completion; never replay an unknown outcome.', required: ['plan', 'approval', 'approved', 'allowRootWorker', 'allowDownloads'], optional: [] },
  bootstrap_status: { description: 'Inspect retained installation progress without retry or repair.', required: [], optional: [] },
} satisfies Record<string, { description: string; required: string[]; optional: string[] }>
const ordinary = new Set(['status', 'read', 'write', 'search', 'exec'])
const fields: ToolParameters['properties'] = {
  installation: { type: 'object', description: 'Existing trusted installation {apiRoot,bundle,image,distribution,node}; explicit installation approval required.' },
  approved: { type: 'boolean' }, allowRootWorker: { type: 'boolean' }, allowDownloads: { type: 'boolean' },
  plan: { type: 'string' }, approval: { type: 'object', description: 'Exact recorded human decision {sessionId,physicalId,requestId} for the installation plan.' },
  distribution: { type: 'string' },
}
export function validateLayerArgs(a: Record<string, unknown>, projectId: string) {
  if (!ordinary.has(String(a.action))) throw new ToolNoEffectError('Only branch-backed ordinary operations are supported internally.')
  if (typeof a.workspace !== 'string') throw new ToolNoEffectError('Registered LayerFS workspace required.')
  const binding = parseBranchWorkspace(a.workspace)
  if (binding.version !== 3 || binding.ownerProject !== projectId) throw new ToolNoEffectError('Workspace requires an explicit current-Project resource binding; no legacy fallback.')
  for (const key of ['path', 'command', 'content']) if (a[key] !== undefined && typeof a[key] !== 'string') throw new ToolNoEffectError(`Invalid ${key}.`)
  if (['read', 'write'].includes(String(a.action)) && !a.path) throw new ToolNoEffectError('Missing path.')
  if (a.action === 'write' && typeof a.content !== 'string') throw new ToolNoEffectError('Missing content.')
  if (a.action === 'exec' && !a.command) throw new ToolNoEffectError('Missing command.')
  if (typeof a.path === 'string' && (a.path.includes('\0') || a.path.split('/').includes('..'))) throw new ToolNoEffectError('Sandbox path traversal refused.')
  for (const key of ['command', 'content']) if (typeof a[key] === 'string' && Buffer.byteLength(a[key]) > 65536) throw new ToolNoEffectError(`${key} exceeds 64 KiB.`)
}

/** Installation adapter plus ordinary resource routing. Git/Docker/SDK workflows live in skills. */
export class LayerFSTool implements Tool<ToolResult> {
  readonly name = 'layerfs'
  readonly description = 'Internal installation and branch-backed ordinary tool adapter; public calls use flattened contracts.'
  static readonly parameters: ToolParameters = { type: 'object', additionalProperties: false, properties: { action: { type: 'string' }, ...fields }, required: ['action'] }
  readonly parameters = LayerFSTool.parameters
  private readonly managed?: ManagedLayerFS
  constructor(private readonly projectId: string, private readonly home?: string, managed?: ManagedLayerFS, private readonly bootstrap?: LayerFSBootstrap) {
    this.managed = managed ?? (home ? managedLayerFS(projectId, home) : undefined)
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext, lifecycle?: { observe: (text: string) => void }): Promise<ToolResult> {
    if (context.projectId !== this.projectId || context.remoteWorkdir) throw new ToolNoEffectError('Current local Project required; no fallback.')
    context.signal.throwIfAborted()
    const action = String(args.action)
    if (ordinary.has(action)) {
      validateLayerArgs(args, this.projectId)
      if (!this.home) throw new ToolNoEffectError('Project resource catalog unavailable.')
      const { layerfsResources } = await import('../execution/layerfs/resource-service.ts')
      const output = await layerfsResources(this.projectId, this.home).execute(action, args, context, lifecycle)
      if (typeof output === 'string' && JSON.parse(output).ok === false) return completedToolFailure({ isError: true, content: [{ type: 'text', text: output }] })
      return output
    }
    if (!Object.hasOwn(installationIntents, action)) throw new ToolNoEffectError('Unsupported LayerFS action; use official SDK through exec for standard workflows.')
    const contract = installationIntents[action as keyof typeof installationIntents]
    const allowed: string[] = ['action', ...contract.required, ...contract.optional]
    for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new ToolNoEffectError(`Unexpected ${key}.`)
    const managed = !process.env.SHADOW_LAYERFS_CONFIG ? this.managed : undefined
    let result: unknown
    if (action === 'doctor') {
      if (managed) {
        const retained = await managed.describe()
        result = { configured: retained.configured, mode: 'managed-artifacts', runtime: 'not_checked', next: retained.configured ? 'layerfs_runtime_plan' : 'layerfs_bootstrap_plan' }
      } else {
        try { await configuration(this.projectId); result = { configured: true, runtime: 'not_checked' } }
        catch (error) { if (!(error instanceof LayerFSConfigurationError)) throw error; result = { configured: false, runtime: 'not_checked', code: error.code, message: error.message } }
      }
    } else {
      if (!managed) throw new ToolNoEffectError('Owning managed Project installation required; operator configuration is not replaced.')
      if (action === 'setup') {
        assertLayerFSSetupOwner(context)
        if (args.approved !== true || args.allowRootWorker !== true) throw new ToolNoEffectError('Explicit installation and root worker consent required; no worker started.')
        result = await managed.setup(args.installation, context.signal)
      } else {
        if (!this.bootstrap) throw new ToolNoEffectError('Owning Project bootstrap service unavailable.')
        result = action === 'bootstrap_plan' ? await this.bootstrap.plan(context, args.distribution)
          : action === 'bootstrap_status' ? await this.bootstrap.status(context) : await this.bootstrap.start(args, context)
      }
    }
    return JSON.stringify({ ok: true, result })
  }
}

export function layerFSToolContracts() {
  return [...layerfsResourceContracts(), ...Object.entries(installationIntents).map(([action, value]) => ({
    name: `layerfs_${action}`, description: value.description, supportsLayerFSWorkdir: true,
    parameters: { type: 'object' as const, additionalProperties: false, properties: Object.fromEntries([...value.required, ...value.optional].map(key => [key, fields[key]])), required: [...value.required] },
  }))]
}
export function createLayerFSTools(...args: ConstructorParameters<typeof LayerFSTool>): Tool<ToolResult>[] {
  const dispatcher = new LayerFSTool(...args)
  return layerFSToolContracts().filter(contract => Object.hasOwn(installationIntents, contract.name.slice('layerfs_'.length))).map(contract => ({
    ...contract, async execute(input, context) {
      for (const key of Object.keys(input)) if (!Object.hasOwn(contract.parameters.properties, key)) throw new ToolNoEffectError(`Unexpected ${key}.`)
      for (const key of contract.parameters.required) if (input[key] === undefined) throw new ToolNoEffectError(`Missing ${key}.`)
      for (const [key, value] of Object.entries(input)) {
        const type = contract.parameters.properties[key].type
        if (type === 'object' ? value === null || typeof value !== 'object' || Array.isArray(value) : typeof value !== type) throw new ToolNoEffectError(`Invalid ${key}.`)
      }
      return dispatcher.execute({ ...input, action: contract.name.slice('layerfs_'.length) }, context)
    },
  }))
}
