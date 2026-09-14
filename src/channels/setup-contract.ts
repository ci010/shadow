/** Public channel setup wire contract; safe to import in the renderer. */
export const CHANNEL_IDS = ['qq', 'feishu', 'discord'] as const
export type ChannelId = typeof CHANNEL_IDS[number]
export type ChannelState = 'disabled' | 'unconfigured' | 'connecting' | 'connected'
  | 'disconnected' | 'error' | 'running' | 'restart-required'

export interface ChannelSetupStatus {
  id: ChannelId
  label: string
  enabled: boolean
  configured: boolean
  state: ChannelState
  message?: string
  config: Record<string, string | boolean | number | string[]>
  secrets: Record<string, boolean>
}
