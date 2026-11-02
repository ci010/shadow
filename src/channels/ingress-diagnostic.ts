/** SDK failures may embed user text, URLs and credentials. Report only fixed
 * classifications, never arbitrary names/codes, messages, stacks or objects. */
export type IngressStage = 'stream' | 'admission' | 'dispatch'
const stages = new WeakMap<object, IngressStage>()
export function markIngressFailure(error: unknown, stage: IngressStage): void {
  if (error && typeof error === 'object' && !stages.has(error)) stages.set(error, stage)
}
const integrationCodes = new Set(['binding_required', 'channel_access_denied', 'bot_disabled', 'connection_changed',
  'admission_capacity', 'unavailable', 'policy_changed', 'verified_input_required', 'stale_context',
  'observation_disabled', 'observation_permission', 'observation_scope', 'observation_changed', 'observation_capacity'])
const systemCodes = new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EIO','ECONNRESET','ETIMEDOUT'])
const admissionReasons = new Map([
  ['No input listener subscription; input not delivered', 'listener_missing'],
  ['No input listener subscription; policy not executed', 'listener_missing'],
  ['Explicit service assignment required; configure this Bot in Web', 'assignment_required'],
  ['Selected BOT receive configuration required', 'receive_configuration_required'],
  ['Verified owner direct messages only', 'owner_required'],
  ['The source bot connection is unavailable', 'connection_unavailable'],
  ['Verified Discord location required', 'location_required'],
  ['Connection changed', 'connection_changed'],
])
const events = new Set(['MESSAGE_CREATE','MESSAGE_UPDATE','MESSAGE_DELETE','MESSAGE_DELETE_BULK',
  'THREAD_CREATE','THREAD_UPDATE','THREAD_DELETE','THREAD_LIST_SYNC','READY','RESUMED',
  'GROUP_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE','C2C_MESSAGE_CREATE','AT_MESSAGE_CREATE',
  'DIRECT_MESSAGE_CREATE','GROUP_ADD_ROBOT','CHANNEL_CREATE','CHANNEL_UPDATE','CHANNEL_DELETE'])
export function ingressDispatchEvent(event: unknown): string {
  return typeof event === 'string' && events.has(event) ? event : 'other'
}
export function ingressErrorDetail(error: unknown): string {
  const describe = (value: unknown, depth: number): string => {
    if (!(value instanceof Error)) return 'category=non_error'
    const stage = stages.get(value) ?? 'dispatch'
    let category = 'unknown'
    const code = (value as Error & {code?: unknown}).code
    if (value.name === 'IntegrationError') category = typeof code === 'string' && integrationCodes.has(code) ? `integration:${code}` : 'integration'
    else if (value.name === 'ChannelAdmissionError') category = `admission:${admissionReasons.get(value.message) ?? 'denied'}`
    else if (value.name === 'ChannelConnectionError') category = 'connection'
    else if (value.name === 'AbortError') category = 'aborted'
    else if (value.name === 'ZodError') category = 'schema'
    else if (value.message === 'Watermark journal conflict; reload before retrying') category = 'journal_conflict'
    else if (value.message === 'Channel stream Project mismatch') category = 'stream_project_mismatch'
    if (typeof code === 'string' && systemCodes.has(code)) category = `system:${code}`
    return `phase=${stage} category=${category}${depth < 2 && value.cause !== undefined ? ` cause={${describe(value.cause, depth + 1)}}` : ''}`
  }
  try { return describe(error, 0) } catch { return 'phase=dispatch category=uninspectable' }
}
