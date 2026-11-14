import { createPinia, disposePinia, type Pinia } from 'pinia'
import { createApp, getCurrentInstance, type App, type Component, type Plugin } from 'vue'

/** No active-Pinia fallback: a missing root must not borrow another app's auth scope. */
export function requireResourcePinia(): Pinia {
  const pinia = getCurrentInstance()?.appContext.config.globalProperties.$pinia as Pinia | undefined
  if (!pinia) throw new Error('Resource stores require a Vue application with resource Pinia installed.')
  return pinia
}

/** Every root, including auth/recovery/mobile roots, gets its own disposable store scope. */
export function createResourceStores(): Plugin {
  const pinia = createPinia()
  let installed = false
  return {
    install(app: App) {
      if (installed) throw new Error('Resource stores cannot be shared between Vue applications.')
      installed = true
      app.use(pinia)
      app.onUnmount(() => disposePinia(pinia))
    },
  }
}

export function createResourceApp(root: Component, props?: Record<string, unknown> | null) {
  return createApp(root, props).use(createResourceStores())
}
