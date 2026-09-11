import { inject, provide, type InjectionKey, type Ref } from 'vue'
import type { ProviderSetupInput } from './provider-setup.ts'

export interface ModelSelection {
  current: Readonly<Ref<string>>
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

export function filterModelOptions(options: readonly string[], current: string, query: string): string[] {
  const models = [...new Set([...options, ...(current ? [current] : [])])]
  return models.filter(model => model.toLowerCase().includes(query.trim().toLowerCase()))
}
