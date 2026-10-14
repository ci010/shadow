import { REASONING_EFFORTS, type LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { ModelInfo } from '../providers/provider.ts'
import { MODEL_CONTEXT_WINDOWS } from '../providers/model-registry.ts'
import { parseModelSpec } from '../providers/aggregated.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

/** Narrow, credential-free input; never serialize provider/config objects. */
export interface ModelsSnapshot {
  models: ModelInfo[]
  defaults: Pick<LlmRuntimeConfig, 'model' | 'reasoningEffort'>
  contextOverride?: (id: string) => number | undefined
}

export function createModelsHandler(snapshot: () => Promise<ModelsSnapshot>): {
  read: VirtualFsHandler; list: VirtualFsListHandler
} {
  const entries = async () => {
    const current = await snapshot()
    return current.models.filter(model => model.selectable !== false).map(model => {
      const bare = parseModelSpec(model.id).model
      const override = current.contextOverride?.(model.id)
      const context = override ?? model.contextWindow ?? MODEL_CONTEXT_WINDOWS[bare]
      const efforts = model.reasoningEfforts?.filter(effort => REASONING_EFFORTS.some(value => value === effort))
      // Explicit projection: provider extensions, endpoints, keys and URLs never enter output.
      return { name: model.id, content: JSON.stringify({
        id: model.id,
        provenance: 'Current configured provider catalog (same catalog used for subagent inference validation); not a live availability check.',
        capabilities: { imageInput: model.vision ?? 'unknown', toolUse: 'unknown' },
        reasoningEfforts: efforts ?? 'unknown',
        projectDefaultModel: current.defaults.model,
        projectDefaultEffort: current.defaults.reasoningEffort ?? 'unset',
        defaultsProvenance: 'Current Project runtime defaults; role, conversation and caller overrides may differ. Not model-specific recommended defaults.',
        reasoningEffortsProvenance: model.reasoningEfforts === undefined ? 'Not advertised; validation does not constrain unknown support.' : 'Provider metadata intersected with Shadow effort enum.',
        contextTokens: context ?? 'unknown',
        contextProvenance: override !== undefined ? 'Configured per-model override (runtime budget, not verified model capacity).'
          : model.contextWindow !== undefined ? 'Provider catalog metadata.'
          : context !== undefined ? 'Built-in model context registry (not independently verified).'
          : 'Not advertised; runtime fallback is not evidence of model capacity.',
        maxOutputTokens: model.maxOutputTokens ?? 'unknown',
        outputProvenance: model.maxOutputTokens === undefined ? 'Not advertised.' : 'Provider catalog metadata; not the per-request maxTokens budget.',
        parameterCount: 'unknown',
        measuredPerformance: 'unknown',
        guidance: {
          provenance: 'Curated Shadow task-selection heuristics, not benchmarks or provider guarantees.',
          suitability: model.vision === true ? 'Candidate for image-grounded tasks; verify image/tool support in the actual request.'
            : model.vision === false ? 'Use for text tasks, not image-grounded tasks.' : 'Start with text tasks; image and tool capabilities require verification.',
          effort: 'For bounded extraction or straightforward edits, consider a lower supported effort; for complex reasoning, consider a higher supported effort. No speed, cost or quality ranking is measured here.',
        },
      }, null, 2) }
    }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }
  return {
    async read(path, context) {
      context.signal.throwIfAborted()
      const all = await entries()
      context.signal.throwIfAborted()
      if (path) {
        const entry = all.find(entry => entry.name === path)
        if (!entry) throw new Error('Unknown or non-selectable model ID in current provider catalog.')
        return entry.content
      }
      return [
        'Configured selectable models: copy an exact id into subagent.model. Discovery grants no permissions and does not guarantee credentials, quota, connectivity or live availability.',
        'Omit model/effort to preserve task role defaults or call caller settings. Effort omission inherits existing defaults, not an automatic supported value; a known unsupported inherited effort can fail validation when changing model. Unknown support is not a guarantee.',
        'Context/output metadata describes limits or budgets, not measured task performance. Size and performance stay unknown without evidence.',
        ...all.map(entry => entry.content),
      ].join('\n\n')
    },
    async list(context, options) {
      context.signal.throwIfAborted()
      const all = await entries()
      context.signal.throwIfAborted()
      return all.filter(entry => !options?.subpath || entry.name === options.subpath || entry.name.startsWith(`${options.subpath}/`))
        .map(entry => ({ ...entry, content: options?.content === false ? '' : entry.content }))
    },
  }
}
