import { IPC_CHANNELS } from './ipc-contract.js'
import { parseDesktopWebPairing, type DesktopWebPairingApi } from './web-pairing-contract.js'

export function createWebPairingApi(ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }): DesktopWebPairingApi {
  return Object.freeze({
    create: async (lan?: boolean) => parseDesktopWebPairing(await ipc.invoke(IPC_CHANNELS.createWebPairing, ...(lan === undefined ? [] : [lan]))),
  })
}
