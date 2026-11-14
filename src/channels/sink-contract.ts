/** Renderer-safe inspection only. No credentials, permissions, copied BOT
 * selectors or execution/session authority. `botInstanceId` is the established
 * transport connection wire identity, NOT a BOT.md role.
 */
export interface ChannelSinkAddress {
  projectId: string
  botInstanceId: string
  platform: 'qq' | 'feishu' | 'discord' | 'wechat'
  conversationId: string
}

/** A section action never navigates to a thread. Threads remain separate durable
 * identities underneath their parent's existing channel content/history browser.
 * Unknown channel type stays null, never inferred from a name or invented as 15.
 */
export type ChannelSinkNavigation =
  | { kind: 'conversation'; address: ChannelSinkAddress; inboxSessionId: string }
  | { kind: 'channel-content'; address: ChannelSinkAddress & { platform: 'discord' }; channelType: 0 | 5 | 15 | null;
      guildId: string | null; view: 'messages-and-threads' | 'threads' }
  | { kind: 'connection-content'; projectId: string; connectionId: string }

export interface ChannelSinkReceiver {
  /** Stable parent/group inbox identity, not a BOT/Workflow identity. */
  id: string
  address: ChannelSinkAddress
  name?: string
  path: string
  navigation: ChannelSinkNavigation
}
export interface ConnectionSinkProjection {
  kind: 'connection-sink'
  id: string
  projectId: string
  connectionId: string
  /** v:connections/<encoded connectionId>/overview.json */
  connectionPath: string
  /** v:connections/<encoded connectionId>/sink.json */
  sinkPath: string
  sink: { kind: 'common-receipt'; reacts: false; navigation: Extract<ChannelSinkNavigation, { kind: 'connection-content' }> }
  /** Real observed top-level groups/channels only; never thread assign objects. */
  receivers: ChannelSinkReceiver[]
  /** References only. BOT.md remains the sole subscription/admission authority. */
  bots: Array<{ botId: string; path: string; workflowIds: string[] }>
  guidePath: 'v:bots/authoring'
}
