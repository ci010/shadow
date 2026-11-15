import type { ChannelSinkNavigation } from '../../src/channels/sink-contract.ts'
import { parseConnectionSinkProjection } from '../../src/shared/connection-sink.ts'
import type { WorkflowCanvasEntry } from './workflow-canvas.ts'
import { discordChannelId } from './discord-navigation.ts'
import { receiverLabel } from './receiver-label.ts'
import { t } from './i18n.ts'
export { parseConnectionSinkProjection }

/** One transport root with metadata-backed conversations and observed parent channels; never thread/BOT nodes. */
export function connectionSinkCanvas(raw: unknown, projectId: string, name: string): WorkflowCanvasEntry {
  const projection = parseConnectionSinkProjection(raw, projectId)
  return { definition: { id: projection.id, name, enabled: true }, projection: true,
    graph: [
      { id: 'connection', nodeType: 'connection', label: t('Connection'), detail: projection.connectionId,
        config: { projectId, connectionId: projection.connectionId, path: projection.connectionPath }, status: 'unknown' },
      ...projection.receivers.map(receiver => ({ id: `receiver:${receiver.id}`, nodeType: 'sink' as const,
        label: receiverLabel(receiver), detail: t('Message receiver'),
        description: receiver.evidence?.sessionMetadata === 'present' ? t('Session metadata exists; message receipt, persistence and execution are unknown.')
          : receiver.evidence?.discovery === 'observed' ? t('Discovery only; message receipt, persistence and execution are unknown.')
          : t('Configuration and existing sessions are not message admission or execution receipts.'),
        config: receiver, status: 'unknown' as const })),
      ...(projection.receivers.length ? [] : [{ id: 'sink', nodeType: 'sink' as const, label: t('Message receiver'),
        detail: t('No conversation evidence available'), config: { path: projection.sinkPath }, status: 'unknown' as const }]),
    ], sinkProjection: projection,
  }
}
export function sinkNavigationLabel(target: ChannelSinkNavigation): string {
  switch (target.kind) {
    case 'conversation': return t('Open message history')
    case 'channel-content': return target.view === 'threads' ? t('Open thread list') : t('Open messages and threads')
    case 'connection-content': return t('Open connection content')
  }
}
export function sinkNavigationLocation(target: ChannelSinkNavigation) {
  if (target.kind === 'conversation') return { name: 'chat', params: { projectId: target.address.projectId, sessionId: target.inboxSessionId } }
  if (target.kind === 'channel-content' && target.guildId) return { name: 'chat', params: {
    projectId: target.address.projectId, sessionId: discordChannelId({ projectId: target.address.projectId,
      botInstanceId: target.address.botInstanceId, guildId: target.guildId, channelId: target.address.conversationId }) } }
}
