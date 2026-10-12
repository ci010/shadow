import { inject, provide, type InjectionKey, type Ref } from 'vue'
import { t } from './i18n.ts'
import { providerFailureMessage, type ProviderSetupStatus } from './provider-setup.ts'
import { modelProvider } from './model-selection.ts'

export interface ProviderReadiness {
  status: Readonly<Ref<ProviderSetupStatus | null>>
  checking: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  enabled: Readonly<Ref<boolean>>
  canConfigure: Readonly<Ref<boolean>>
  retry(): void
}
const key: InjectionKey<ProviderReadiness> = Symbol('provider-readiness')
export function provideProviderReadiness(value: ProviderReadiness): void { provide(key, value) }
export function useProviderReadiness(): ProviderReadiness | null { return inject(key, null) }

// Setup checks Main's primary provider, not every provider in the model catalog.
// Unsuffixed models also route to the primary provider (AggregatedProvider).
export function providerReadinessMessage(status: ProviderSetupStatus | null, checking: boolean, error: string, model: string): string {
  const provider = modelProvider(model)
  if (status && provider && provider !== status.provider) return ''
  if (checking) return t('Checking model provider readiness...')
  if (error) return error
  if (status?.ready) return ''
  if (!status) return t('Could not check provider configuration. Retry when Main is available.')
  switch (status.reason) {
    case 'missing_credentials':
    case 'invalid_credentials': return providerFailureMessage('authentication')
    case 'missing_base_url': return t('Set a base URL in provider settings before sending.')
    case 'proxy_error': return providerFailureMessage('proxy')
    case 'network_error': return providerFailureMessage('network')
    case 'storage_error': return providerFailureMessage('storage')
    default: return providerFailureMessage('unknown')
  }
}

export function providerBlocksSubmission(message: string, answeringQuestion: boolean, queue: boolean): boolean {
  return !!message && !(answeringQuestion && !queue)
}
