import { t, type MessageKey } from './i18n.ts'

const labels: Readonly<Record<string, MessageKey>> = {
  pending: 'pending', running: 'running', completed: 'completed', failed: 'failed',
  cancelled: 'cancelled', waiting: 'waiting', queued: 'queued', expired: 'expired',
  applying: 'applying', applied: 'applied', paused: 'paused', idle: 'idle',
  approved: 'approved', rejected: 'rejected', active: 'active', revoked: 'revoked',
  open: 'open', closed: 'closed', merged: 'merged', unknown: 'unknown',
  passed: 'passed', success: 'success', failure: 'failure', error: 'error',
  blocked: 'blocked', done: 'done', in_progress: 'in progress', stale: 'stale',
  skipped: 'skipped', neutral: 'neutral', timed_out: 'timed out',
  session: 'session', task: 'task', call: 'call', fresh: 'fresh', successor: 'successor',
  user: 'user', parent: 'parent', caller: 'caller', assistant: 'assistant', tool: 'tool',
  system: 'system', context: 'context', developer: 'developer',
  shared: 'shared', 'agent-private': 'agent-private',
  memory: 'memory', wiki: 'wiki', skill: 'skill',
  camera: 'camera', microphone: 'microphone', screen: 'screen', file: 'file', form: 'form',
  silent: 'silent', queue: 'queue',
  cites: 'cites', reconsiders: 'reconsiders', supersedes: 'supersedes', 'superseded-by': 'superseded by',
  APPROVED: 'APPROVED', CHANGES_REQUESTED: 'CHANGES_REQUESTED', COMMENTED: 'COMMENTED',
  DISMISSED: 'DISMISSED', PENDING: 'PENDING', REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  ALL: 'ALL', USER: 'USER', SESSION: 'SESSION', ASSISTANT: 'ASSISTANT',
  TOOL: 'TOOL', CONTEXT: 'CONTEXT', SYSTEM: 'SYSTEM',
}

/** Translate known presentation enums, never arbitrary server or user content. */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return ''
  const message = Object.hasOwn(labels, value) ? labels[value] : undefined
  return message ? t(message) : value
}
