import type { Tool, ToolResult } from './tool.ts'
import { ToolNoEffectError } from './tool.ts'
import type { LayerFSResources } from '../execution/layerfs/resource-service.ts'

const fields = {
  runtimeId: { type: 'string', description: 'Explicit current-Project runtime ID.' },
  sourceName: { type: 'string', description: 'Optional single directory name beneath this runtime’s dedicated WSL-native sourceRoot. Direct owner binding for Init, rechecked against native ext4 filesystem identity on every dispatch. No arbitrary paths, UNC, different distro or DrvFS. Omit to obtain sourceRoot before standard source preparation.' },
  name: { type: 'string' }, resourceId: { type: 'string', description: 'Immutable registered resource ID.' },
  layerfsProject: { type: 'string', description: 'Existing official project in the selected runtime.' },
  image: { type: 'string', description: 'Exact installed sha256 image ID, checked against official project metadata.' },
  baselineRef: { type: 'string', description: 'Immutable official Layer hash; not a moving branch name.' },
  source: { type: 'object', additionalProperties: false, required: ['repository', 'commit'], properties: { repository: { type: 'string' }, commit: { type: 'string' } } },
}
const intents: Record<string, { description: string; required: string[]; optional?: string[] }> = {
  runtime_plan: { description: 'Record isolated runtime binding from approved installation artifacts; no downloads, Git or Docker build.', required: ['runtimeId'] },
  runtime_start: { description: 'Start a planned runtime or explicitly restart its confirmed normal stop, only from the original owner session. Running/concurrent starts and unknown ownership are not replayed.', required: ['runtimeId'] },
  runtime_status: { description: 'Inspect runtime without starting it.', required: ['runtimeId'] },
  runtime_context: { description: 'Return a controlled ordinary-exec launcher for official SDK calls using the existing runtime owner. No endpoint secret is returned.', required: ['runtimeId'], optional: ['sourceName'] },
  resource_register: { description: 'Register existing official project/image/immutable baseline after official identity checks. Does not build, import or smoke-test a recipe. Source provenance is caller supplied.', required: ['runtimeId', 'name', 'layerfsProject', 'image', 'baselineRef', 'source'] },
  resource_list: { description: 'List immutable current-Project resource registrations.', required: [] },
  resource_inspect: { description: 'Inspect an exact registered resource.', required: ['resourceId'] },
}
export function layerfsResourceContracts() {
  return Object.entries(intents).map(([intent, value]) => ({ name: `layerfs_${intent}`, description: value.description, supportsLayerFSWorkdir: true,
    parameters: { type: 'object' as const, additionalProperties: false, properties: Object.fromEntries([...value.required, ...value.optional ?? []].map(key => [key, fields[key as keyof typeof fields]])), required: [...value.required] } }))
}
export function createLayerFSResourceTools(service: LayerFSResources): Tool<ToolResult>[] {
  return layerfsResourceContracts().map(contract => ({ ...contract, async execute(input, context) {
    if (context.projectId !== service.projectId || context.remoteWorkdir || context.recoveringToolCall || context.scriptInvocation) throw new ToolNoEffectError('Direct current-Project invocation required; no replay/fallback.')
    for (const key of Object.keys(input)) if (!Object.hasOwn(contract.parameters.properties, key)) throw new ToolNoEffectError(`Unexpected ${key}.`)
    for (const key of contract.parameters.required) if (input[key] === undefined) throw new ToolNoEffectError(`Missing ${key}.`)
    if (input.sourceName !== undefined && typeof input.sourceName !== 'string') throw new ToolNoEffectError('sourceName must be a single native directory name.')
    let result: unknown
    switch (contract.name) {
      case 'layerfs_runtime_plan': result = await service.runtimePlan(String(input.runtimeId), context); break
      case 'layerfs_runtime_start': result = await service.runtimeStart(String(input.runtimeId), context); break
      case 'layerfs_runtime_status': result = await service.runtimeStatus(String(input.runtimeId), context.signal); break
      case 'layerfs_runtime_context': result = await service.runtimeContext(String(input.runtimeId), context, typeof input.sourceName === 'string' ? input.sourceName : undefined); break
      case 'layerfs_resource_register': result = await service.register(input, context); break
      case 'layerfs_resource_list': result = service.catalog.list(); break
      case 'layerfs_resource_inspect': result = service.catalog.get(String(input.resourceId)); break
      default: throw new ToolNoEffectError('Unsupported resource action.')
    }
    return JSON.stringify({ ok: true, result })
  } }))
}
