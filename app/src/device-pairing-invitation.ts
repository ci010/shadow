import { parseDeviceInvitation, type DeviceInvitation } from './components/device-administration.ts'

const prefix = 'shadow-child:v1:'
const invalid = () => new Error('Invalid Child invitation. Copy the complete invitation from Main > Nodes.')

export interface ChildInvitation extends DeviceInvitation {
  endpoint: string
}

function validate(value: unknown): ChildInvitation {
  if (!value || typeof value !== 'object' || !('endpoint' in value) || typeof value.endpoint !== 'string') throw invalid()
  const invitation = parseDeviceInvitation(value)
  const endpoint = new URL(value.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw invalid()
  return { ...invitation, endpoint: endpoint.origin }
}

export function encodeChildInvitation(endpoint: string, invitation: DeviceInvitation): string {
  return prefix + btoa(JSON.stringify(validate({ ...invitation, endpoint })))
}

export function decodeChildInvitation(text: string, now = Date.now()): ChildInvitation {
  let invitation: ChildInvitation
  try {
    const input = text.trim()
    if (input.length > 4096 || !input.startsWith(prefix)) throw invalid()
    invitation = validate(JSON.parse(atob(input.slice(prefix.length))))
  } catch {
    throw invalid()
  }
  if (Date.parse(invitation.expiresAt) <= now) {
    throw new Error('This invitation has expired. Create and copy a new invitation on Main.')
  }
  return invitation
}
