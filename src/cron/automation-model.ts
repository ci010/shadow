export interface AutomationModelConfig {
  workObserver: { model?: string; organizerModel?: string }
  agent: { model: string; quickModel?: string }
}
/** Dispatch fallback is intentionally independent of any saved execution session. */
export function automationModelSettings(config: AutomationModelConfig, id: string) {
  return {
    model: id === 'system:work-observer' ? config.workObserver.model : config.workObserver.organizerModel,
    defaultModel: (id === 'system:work-organizer' ? config.workObserver.model : undefined) ?? config.agent.quickModel ?? config.agent.model,
  }
}
export function automationDispatchModel(config: AutomationModelConfig, id: string): string {
  const settings = automationModelSettings(config, id)
  return settings.model ?? settings.defaultModel
}
