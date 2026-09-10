import {
  inject,
  type InjectionKey,
  type Plugin,
  readonly,
  ref,
  type Ref,
} from 'vue'
import {
  createLocalMainAdminContext,
  type InstallationContextV1,
} from '../installation-context.ts'

type InstallationContextRef = Readonly<Ref<InstallationContextV1>>

const installationContextKey: InjectionKey<InstallationContextRef> = Symbol(
  'installation-context',
)

export function createInstallationContextProvider(
  initialContext: InstallationContextV1,
): Plugin {
  return {
    install(app) {
      app.provide(installationContextKey, readonly(ref(initialContext)))
    },
  }
}

export function useInstallationContext(): InstallationContextRef {
  const context = inject(installationContextKey, null)
  if (context) return context

  const apiBase = typeof location === 'undefined' ? '' : globalThis.location.origin
  return readonly(ref(createLocalMainAdminContext(apiBase)))
}