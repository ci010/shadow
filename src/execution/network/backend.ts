import { setGlobalDispatcher } from 'undici'
import { localProxyConfiguration } from './proxy.ts'
import { LocalProxyDispatcher } from './proxy-client.ts'

let initialization: Promise<void> | undefined

/** One outbound policy for the lifetime of the Main backend process. */
export function initializeBackendNetwork(): Promise<void> {
  return initialization ??= configure().catch(error => {
    initialization = undefined
    throw error
  })
}

async function configure(): Promise<void> {
  const configuration = await localProxyConfiguration()
  if (configuration.source !== 'direct') {
    setGlobalDispatcher(new LocalProxyDispatcher(configuration))
  }
  console.info(`[network] Backend proxy source: ${configuration.source}; loopback stays direct.`)
}
