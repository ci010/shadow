export async function registerBrowserPwa(options: {
  production: boolean
  desktop: boolean
  secureContext: boolean
  protocol: string
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>
}): Promise<ServiceWorkerRegistration | undefined> {
  if (!options.production || options.desktop || !options.secureContext
    || !['http:', 'https:'].includes(options.protocol) || !options.serviceWorker) return
  return options.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
}
