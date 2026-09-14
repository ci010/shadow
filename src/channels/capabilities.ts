export interface ChannelCapabilities {
  conversation: 'unknown' | 'direct' | 'group' | 'thread' | 'web'
  format: 'plain' | 'markdown' | 'card'
  codeBlocks: boolean
  tables: boolean
  outboundMedia: readonly ('image' | 'file' | 'audio' | 'video')[]
  updates: 'none' | 'replace' | 'stream'
  threads: 'none' | 'public' | 'topic'
  decisions: 'text' | 'buttons' | 'native'
}

/** Unknown or unavailable destinations must not inherit platform-wide features. */
export function unavailableCapabilities(): ChannelCapabilities {
  return {
    conversation: 'unknown', format: 'plain', codeBlocks: false, tables: false,
    outboundMedia: [], updates: 'none', threads: 'none', decisions: 'text',
  }
}
