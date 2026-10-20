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

/** Group by provider type, never by account ID or the model vendor prefix. */
export function modelProviderGroup(model: string, providers: readonly ProviderInstanceLabel[] = []): string {
  const id = modelProvider(model)
  return providers.find(item => item.id === id)?.type ?? id
}

export function modelProviderFilters(models: readonly string[], providers: readonly ProviderInstanceLabel[] = []): { id: string; label: string; count: number }[] {
  const groups = new Map<string, { id: string; label: string; count: number; names: Set<string>; accounts: Set<string> }>()
  for (const model of new Set(models)) {
    const id = modelProviderGroup(model, providers)
    if (!id) continue
    const group = groups.get(id) ?? { id, label: providerDisplayName(id), count: 0, names: new Set<string>(), accounts: new Set<string>() }
    group.count++
    group.names.add(modelDisplayName(model))
    group.accounts.add(modelProvider(model))
    groups.set(id, group)
  }
  // Small catalogs need no extra navigation; repeated accounts still benefit.
  if (groups.size < 2 || ![...groups.values()].some(group => group.names.size >= 5 || group.accounts.size > 1)) return []
  return [...groups.values()].map(({ id, label, count }) => ({ id, label, count }))
}

/** Keep opaque account IDs out of the compact list, but retain them in tooltips/search. */
export function modelCompactAccountLabel(model: string, providers: readonly ProviderInstanceLabel[] = []): string {
  const id = modelProvider(model)
  const instance = providers.find(item => item.id === id)
  if (!instance) return id
  const peers = providers.filter(item => item.type === instance.type)
  const label = modelAccountLabel(model, providers)
  return peers.length > 1 ? `${label} · #${peers.findIndex(item => item.id === id) + 1}` : label
}
