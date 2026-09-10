import type { ShadowDesktopApi } from './ipc-contract.js'

declare global {
  interface Window {
    readonly shadowDesktop: ShadowDesktopApi
  }
}

export {}