import { z } from 'zod'
import { ConfigSchema, type Config } from './schema.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'

export const MODEL_DEFAULT_FIELDS = ['model', 'quickModel', 'temperature', 'thinking', 'reasoningEffort', 'contextWindow'] as const
const model = z.string().trim().min(1).max(256).regex(/^\S+$/)
export const ModelDefaultsPatchSchema = z.object({
  model: model.nullish(),
  quickModel: model.nullish(),
  temperature: z.number().nullish(),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().nullish(),
  contextWindow: z.union([z.literal(256000), z.literal(400000), z.literal(1000000)]).nullish(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullish(),
}).strict()
export type ModelDefaultsPatch = z.infer<typeof ModelDefaultsPatchSchema>

export function modelFields(agent: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(MODEL_DEFAULT_FIELDS.filter(key => agent[key] !== undefined).map(key => [key, agent[key]]))
}

export function patchModelDefaults(agent: Record<string, unknown>, patch: ModelDefaultsPatch): Record<string, unknown> {
  const next = { ...agent }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return next
}

export function modelDefaultsState(overrides: Record<string, unknown>, effective: Config['agent'], inherited = ConfigSchema.parse({}).agent) {
  return {
    model: effective.model, quickModel: effective.quickModel, temperature: effective.temperature,
    contextWindow: effective.contextWindow,
    thinking: effective.thinking, reasoningEffort: effective.reasoningEffort,
    overrides: modelFields(overrides), inherited: modelFields(inherited),
  }
}
