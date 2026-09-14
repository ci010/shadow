import { parentPort, workerData } from 'node:worker_threads'
import { EventDispatcher, LoggerLevel, WSClient } from '../utils/feishu_sdk.ts'
import type { FeishuCardResponse, FeishuTransportOptions } from './feishu-transport.ts'

const options: FeishuTransportOptions = workerData
if (!parentPort) throw new Error('Feishu transport requires a worker')
const port = parentPort
let requestId = 0
const pending = new Map<number, (response: FeishuCardResponse) => void>()
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('requestId' in message) || typeof message.requestId !== 'number'
    || !('response' in message) || !message.response || typeof message.response !== 'object') return
  const toast = (message.response as FeishuCardResponse).toast
  if (!toast || !['success', 'error', 'info'].includes(toast.type) || typeof toast.content !== 'string') return
  pending.get(message.requestId)?.({ toast: { type: toast.type, content: toast.content.slice(0, 200) } })
})
const dispatcher = new EventDispatcher({
  encryptKey: options.encryptKey,
  verificationToken: options.verificationToken,
}).register({
  'im.message.receive_v1': (event: Record<string, unknown>) => {
    port.postMessage({ event })
    return Promise.resolve()
  },
  'card.action.trigger': (card: Record<string, unknown>) => new Promise<FeishuCardResponse>((resolve) => {
    const id = ++requestId
    const timer = setTimeout(() => finish({ toast: { type: 'info', content: 'Decision is still being processed.' } }), 2_000)
    const finish = (response: FeishuCardResponse) => {
      clearTimeout(timer)
      pending.delete(id)
      resolve(response)
    }
    pending.set(id, finish)
    port.postMessage({ requestId: id, card })
  }),
})
const client = new WSClient({
  appId: options.appId,
  appSecret: options.appSecret,
  // The SDK logs remote payloads/connection URLs; none belong in host logs.
  loggerLevel: LoggerLevel.fatal,
})
try {
  await client.start({ eventDispatcher: dispatcher })
  port.postMessage({ state: 'running' })
} catch {
  port.postMessage({ state: 'error' })
}
