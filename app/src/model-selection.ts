import { inject, provide, type InjectionKey, type Ref } from 'vue'
import { providerDisplayName } from './provider-setup.ts'
import type { ProviderSetupInput } from './provider-setup.ts'
import type { ReasoningSettings } from './session-settings.ts'

export interface ProviderInstanceLabel { id: string; type: string; name?: string }

export interface ModelSelection {
  providers?: Readonly<Ref<readonly ProviderInstanceLabel[]>>
  current: Readonly<Ref<string>>
  inherited?: Readonly<Ref<string>>
  inheriting?: Readonly<Ref<boolean>>
  defaultReasoning?: Readonly<Ref<ReasoningSettings>>
  options: Readonly<Ref<readonly string[]>>
  disabled: Readonly<Ref<boolean>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  select(model: string): Promise<void>
}

const modelSelectionKey: InjectionKey<ModelSelection> = Symbol('model-selection')

export function provideModelSelection(selection: ModelSelection): void {
  provide(modelSelectionKey, selection)
}

export function useModelSelection(): ModelSelection | null {
  return inject(modelSelectionKey, null)
}

export function modelSelectionInput(model: string, currentProvider: string): ProviderSetupInput {
  const suffix = model.lastIndexOf('@')
  return { model, provider: suffix > 0 ? model.slice(suffix + 1) : currentProvider }
}

export function modelDisplayName(model: string): string {
  const suffix = model.lastIndexOf('@')
  return suffix > 0 ? model.slice(0, suffix) : model
}

export function modelProvider(model: string): string {
  const suffix = model.lastIndexOf('@')
  return suffix > 0 ? model.slice(suffix + 1) : ''
}

export function modelAccountLabel(model: string, providers: readonly ProviderInstanceLabel[] = []): string {
  const id = modelProvider(model)
  const instance = providers.find(item => item.id === id)
  if (!instance) return id
  const type = providerDisplayName(instance.type)
  return instance.name ? `${instance.name} · ${type}` : type
}

export function modelOptionLabel(model: string, providers: readonly ProviderInstanceLabel[] = []): string {
  const account = modelAccountLabel(model, providers)
  return account ? `${modelDisplayName(model)} · ${account} · ${modelProvider(model)}` : model
}

export function filterModelOptions(options: readonly string[], current: string, query: string, providers: readonly ProviderInstanceLabel[] = []): string[] {
  const models = [...new Set([...options, ...(current ? [current] : [])])]
  return models.filter(model => `${model} ${modelAccountLabel(model, providers)}`.toLowerCase().includes(query.trim().toLowerCase()))
}
