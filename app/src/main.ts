import { createApp, defineComponent, h, type Component } from 'vue'
import 'uno.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import App from './App.vue'
import router from './router.ts'
import { createInstallationContextProvider } from './composables/useInstallationContext.ts'
import { createLocalMainAdminContext } from './installation-context.ts'
import DataLayoutUpgrade from './DataLayoutUpgrade.vue'
import FirstRunWizard from './FirstRunWizard.vue'
import RuntimeRecovery from './RuntimeRecovery.vue'
import DesktopFrame from './DesktopFrame.vue'
import ChildDesktop from './ChildDesktop.vue'
import BrowserAuth from './BrowserAuth.vue'
import { browserSessionKey, createBrowserSession, mountBrowserSession } from './web-auth.ts'
import {
	resolveDesktopBootstrap,
	type RendererBootstrapOutcome,
	type ShadowDesktopApi,
} from './desktop-bootstrap.ts'
import type { InstallationContextV1 } from './installation-context.ts'
import { registerBrowserPwa } from './pwa.ts'
import { i18n, initializeI18n } from './i18n.ts'

const stopLocalization = initializeI18n(window)
if (import.meta.hot) import.meta.hot.dispose(stopLocalization)

if (import.meta.env.MODE !== 'mobile') void registerBrowserPwa({
	production: import.meta.env.PROD,
	desktop: !!window.shadowDesktop,
	secureContext: window.isSecureContext,
	protocol: window.location.protocol,
	serviceWorker: import.meta.env.PROD && !window.shadowDesktop ? navigator.serviceWorker : undefined,
}).catch(error => console.error('[pwa] Could not enable the installed web app.', error))

const apiBase = import.meta.env.VITE_API_BASE?.trim() || globalThis.location.origin

function desktopRoot(component: Component, props?: Record<string, unknown>) {
	return defineComponent({
		setup: () => () => h(DesktopFrame, null, { default: () => h(component, props) }),
	})
}

function mountMainApp(installationContext: InstallationContextV1): void {
	if (installationContext.mode === 'child') {
		createApp(ChildDesktop, { apiBase: installationContext.apiBase })
			.use(i18n)
			.use(createInstallationContextProvider(installationContext))
			.mount('#app')
		return
	}
	createApp(App)
		.use(i18n)
		.use(router)
		.use(createInstallationContextProvider(installationContext))
		.mount('#app')
}

function renderDesktopOutcome(api: ShadowDesktopApi, outcome: RendererBootstrapOutcome): void {
	if (outcome.view === 'app') {
		mountMainApp(outcome.context)
		return
	}

	if (outcome.view === 'data-upgrade') {
		const upgrade = createApp(desktopRoot(DataLayoutUpgrade, {
			api, initialLayout: outcome.layout,
			onComplete: async () => { upgrade.unmount(); await api.bootstrap.retryRuntime?.(); await startDesktopApp(api) },
		}))
		upgrade.use(i18n).mount('#app')
		return
	}

	if (outcome.view === 'wizard') {
		const wizard = createApp(desktopRoot(FirstRunWizard, {
			api,
			initialState: outcome.initialState,
			loadError: outcome.loadError,
			onComplete: async () => {
				wizard.unmount()
				await startDesktopApp(api)
			},
			onRetryLoad: async () => {
				wizard.unmount()
				await startDesktopApp(api)
			},
		}))
		wizard.use(i18n).mount('#app')
		return
	}

	const clearSetup = api.bootstrap.clear
	const canReset = typeof clearSetup === 'function' && outcome.role !== 'child'
	const recovery = createApp(desktopRoot(RuntimeRecovery, {
		canReset,
		role: outcome.role,
		code: outcome.code,
		failure: outcome.failure,
		revealLog: api.diagnostics ? () => api.diagnostics!.revealStartupLog() : undefined,
		retry: async () => {
			await api.bootstrap.retryRuntime?.()
			const next = await resolveDesktopBootstrap(api)
			recovery.unmount()
			renderDesktopOutcome(api, next)
		},
		reset: canReset
			? async () => {
				await api.bootstrap.clear?.()
				const next = await resolveDesktopBootstrap(api)
				recovery.unmount()
				renderDesktopOutcome(api, next)
			}
			: undefined,
	}))
	recovery.use(i18n).mount('#app')
}

async function startDesktopApp(api: ShadowDesktopApi): Promise<void> {
	renderDesktopOutcome(api, await resolveDesktopBootstrap(api))
}

const desktopApi = window.shadowDesktop
if (import.meta.env.MODE === 'mobile') {
	const { startMobileClient } = await import('./mobile-bootstrap.ts')
	const dispose = await startMobileClient()
	if (import.meta.hot) import.meta.hot.dispose(dispose)
} else if (desktopApi) {
	await startDesktopApp(desktopApi)
} else {
	const session = createBrowserSession(apiBase)
	const stopMounting = mountBrowserSession(session, {
		authenticated: () => {
			const app = createApp(App).use(i18n).use(router)
				.use(createInstallationContextProvider(createLocalMainAdminContext(apiBase)))
				.provide(browserSessionKey, session)
			app.mount('#app')
			return () => app.unmount()
		},
		unauthenticated: () => {
			const auth = createApp(BrowserAuth, { session }).use(i18n)
			auth.mount('#app')
			return () => auth.unmount()
		},
	})
	const stopListening = session.listen(window, document)
	void session.refresh()
	if (import.meta.hot) import.meta.hot.dispose(() => {
		stopMounting()
		stopListening()
		session.dispose()
	})
}
