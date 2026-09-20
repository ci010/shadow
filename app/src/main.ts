import { createApp, defineComponent, h, type Component } from 'vue'
import 'uno.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import App from './App.vue'
import router from './router.ts'
import { createInstallationContextProvider } from './composables/useInstallationContext.ts'
import { createLocalMainAdminContext } from './installation-context.ts'
import FirstRunWizard from './FirstRunWizard.vue'
import RuntimeRecovery from './RuntimeRecovery.vue'
import DesktopFrame from './DesktopFrame.vue'
import BrowserAuth from './BrowserAuth.vue'
import { browserSessionKey, createBrowserSession, mountBrowserSession } from './web-auth.ts'
import {
	resolveDesktopBootstrap,
	type RendererBootstrapOutcome,
	type ShadowDesktopApi,
} from './desktop-bootstrap.ts'
import type { InstallationContextV1 } from './installation-context.ts'

const apiBase = import.meta.env.VITE_API_BASE?.trim() || globalThis.location.origin

function desktopRoot(component: Component, props?: Record<string, unknown>) {
	return defineComponent({
		setup: () => () => h(DesktopFrame, null, { default: () => h(component, props) }),
	})
}

function mountMainApp(installationContext: InstallationContextV1): void {
	createApp(App)
		.use(router)
		.use(createInstallationContextProvider(installationContext))
		.mount('#app')
}

function renderDesktopOutcome(api: ShadowDesktopApi, outcome: RendererBootstrapOutcome): void {
	if (outcome.view === 'app') {
		mountMainApp(outcome.context)
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
		wizard.mount('#app')
		return
	}

	const clearSetup = api.bootstrap.clear
	const recovery = createApp(desktopRoot(RuntimeRecovery, {
		canReset: typeof clearSetup === 'function',
		role: outcome.role,
		code: outcome.code,
		failure: outcome.failure,
		revealLog: api.diagnostics ? () => api.diagnostics!.revealStartupLog() : undefined,
		retry: async () => {
			const next = await resolveDesktopBootstrap(api)
			recovery.unmount()
			renderDesktopOutcome(api, next)
		},
		reset: typeof clearSetup === 'function'
			? async () => {
				await api.bootstrap.clear?.()
				const next = await resolveDesktopBootstrap(api)
				recovery.unmount()
				renderDesktopOutcome(api, next)
			}
			: undefined,
	}))
	recovery.mount('#app')
}

async function startDesktopApp(api: ShadowDesktopApi): Promise<void> {
	renderDesktopOutcome(api, await resolveDesktopBootstrap(api))
}

const desktopApi = window.shadowDesktop
if (desktopApi) {
	await startDesktopApp(desktopApi)
} else {
	const session = createBrowserSession(apiBase)
	const stopMounting = mountBrowserSession(session, {
		authenticated: () => {
			const app = createApp(App).use(router)
				.use(createInstallationContextProvider(createLocalMainAdminContext(apiBase)))
				.provide(browserSessionKey, session)
			app.mount('#app')
			return () => app.unmount()
		},
		unauthenticated: () => {
			const auth = createApp(BrowserAuth, { session })
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
