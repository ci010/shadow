import { setGlobalDispatcher } from 'undici'
import { proxyConfigurationSchema } from './proxy.ts'
import { LocalProxyDispatcher } from './proxy-client.ts'

const serialized = process.env.SHADOW_APP_NETWORK_PROXY
delete process.env.SHADOW_APP_NETWORK_PROXY
if (serialized) {
  const configuration = proxyConfigurationSchema.parse(JSON.parse(serialized))
  if (configuration.source !== 'direct') setGlobalDispatcher(new LocalProxyDispatcher(configuration))
}
