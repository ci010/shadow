import { isDeepStrictEqual } from 'node:util'

export interface AutomationModelConfig {
  organization: { model?: string }
  agent: { model: string; quickModel?: string }
}
/** Only the active organizer has a model override; historical observers have no dispatch settings. */
export function automationModelSettings(config: AutomationModelConfig, id: string) {
  if (id !== 'system:work-organizer') throw new Error('Unknown system automation')
  return { model: config.organization.model, defaultModel: config.agent.quickModel ?? config.agent.model }
}
export function automationDispatchModel(config: AutomationModelConfig, id: string): string {
  const settings = automationModelSettings(config, id)
  return settings.model ?? settings.defaultModel
}

/** Only configuration projected into the automation catalog invalidates its snapshot. */
export function automationCatalogConfigChanged(
  previous: AutomationModelConfig & { learning: unknown },
  next: AutomationModelConfig & { learning: unknown },
): boolean {
  return !isDeepStrictEqual(previous.learning, next.learning)
    || !isDeepStrictEqual(previous.organization, next.organization)
    || previous.agent.model !== next.agent.model
    || previous.agent.quickModel !== next.agent.quickModel
}
