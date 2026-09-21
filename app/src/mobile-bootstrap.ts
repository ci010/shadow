import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { createApp, defineComponent, h, watch, type App as VueApp } from 'vue'
import MainApp from './App.vue'
import MobileConnection from './MobileConnection.vue'
import router from './router.ts'
import { createInstallationContextProvider } from './composables/useInstallationContext.ts'
import { createMobileClientContext } from './installation-context.ts'
import { createMobileSession, createMobileFetch, mobileBootTarget, mobileSessionKey, type CredentialStore } from './mobile-client.ts'
import { installMobileLiveSource } from './live-client.ts'
import { createFetchEventSource } from './mobile-sse.ts'
import { installMobileCaptureRestriction } from './io/mobile-policy.ts'

export async function startMobileClient() {
  let mounted: VueApp | undefined
  const unavailable = (message: string) => {
    mounted?.unmount()
    mounted = createApp(defineComponent({
      setup: () => () => h('main', { role: 'alert', style: 'padding:32px;color:var(--c-text);background:var(--c-bg-card);min-height:100dvh' }, [
        h('h1', 'Mobile client unavailable'), h('p', message),
      ]),
    }))
    mounted.mount('#app')
  }
  if (mobileBootTarget('mobile', Capacitor.isNativePlatform()) !== 'native') {
    unavailable('Install the Android or iOS client to connect securely to Main. This mobile build cannot run as a browser or desktop administrator.')
    return () => mounted?.unmount()
  }
  const originalFetch = globalThis.fetch
  const restoreCapture = installMobileCaptureRestriction()
  const session = createMobileSession(registerPlugin<CredentialStore>('ShadowCredentials'), originalFetch.bind(globalThis))
  const adapter = createMobileFetch({
    fetch: originalFetch.bind(globalThis), credentials: session.credentials,
    webviewOrigin: `${location.protocol}//${location.host}`, signal: session.signal, unauthorized: session.unauthorized,
  })
  globalThis.fetch = adapter
  const restoreLive = installMobileLiveSource(url => createFetchEventSource(url, adapter))
  const removeGuard = router.beforeEach(to => to.name === 'nodes' ? { name: 'chat', params: { projectId: 'default' } } : true)
  const stop = watch(session.view, view => {
    mounted?.unmount()
    mounted = view === 'connected'
      ? createApp(MainApp).use(router).use(createInstallationContextProvider(createMobileClientContext(session.origin.value)))
      : createApp(MobileConnection, { session })
    mounted.provide(mobileSessionKey, session)
    mounted.mount('#app')
  }, { immediate: true, flush: 'sync' })
  let removeListener: (() => Promise<void>) | undefined
  try {
    const listener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => session.setActive(isActive))
    removeListener = () => listener.remove()
    const state = await CapacitorApp.getState()
    if (state.isActive) await session.load()
    else session.setActive(false)
  } catch {
    session.dispose()
    stop()
    void removeListener?.().catch(() => {})
    removeListener = undefined
    removeGuard()
    if (globalThis.fetch === adapter) globalThis.fetch = originalFetch
    restoreLive()
    restoreCapture()
    unavailable('Native app lifecycle support is unavailable. Reinstall the native client; no browser fallback was enabled.')
  }
  return () => {
    stop()
    mounted?.unmount()
    session.dispose()
    void removeListener?.().catch(() => {})
    restoreLive()
    restoreCapture()
    removeGuard()
    if (globalThis.fetch === adapter) globalThis.fetch = originalFetch
  }
}
