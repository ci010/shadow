export const DiscordPermission = {
  administrator: 1n << 3n,
  view: 1n << 10n,
  send: 1n << 11n,
  attach: 1n << 15n,
  createPublicThreads: 1n << 35n,
  sendInThreads: 1n << 38n,
}

export function discordRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Discord response')
  return value as Record<string, unknown>
}

export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
}

function bitfield(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)) throw new Error('Invalid Discord permissions')
  return BigInt(value)
}

/** Discord's guild roles, then everyone/role/member channel overwrite precedence. */
export function discordPermissions(
  guildId: string, botId: string, ownerId: unknown, roles: unknown,
  member: Record<string, unknown>, overwrites: unknown,
): bigint {
  if (!Array.isArray(roles) || !Array.isArray(member.roles)
    || !member.roles.every(isDiscordId) || !Array.isArray(overwrites)) {
    throw new Error('Invalid Discord permissions')
  }
  const assigned = new Set([guildId, ...member.roles])
  const found = new Set<string>()
  let permissions = 0n
  for (const value of roles) {
    const role = discordRecord(value)
    if (!isDiscordId(role.id)) throw new Error('Invalid Discord role')
    const bits = bitfield(role.permissions)
    if (assigned.has(role.id)) {
      found.add(role.id)
      permissions |= bits
    }
  }
  if ([...assigned].some(id => !found.has(id))) throw new Error('Missing Discord role')
  if (ownerId === botId || (permissions & DiscordPermission.administrator) !== 0n) return ~0n

  let everyoneAllow = 0n, everyoneDeny = 0n, roleAllow = 0n, roleDeny = 0n, userAllow = 0n, userDeny = 0n
  for (const value of overwrites) {
    const overwrite = discordRecord(value)
    if (!isDiscordId(overwrite.id) || (overwrite.type !== 0 && overwrite.type !== 1)) {
      throw new Error('Invalid Discord overwrite')
    }
    const allow = bitfield(overwrite.allow), deny = bitfield(overwrite.deny)
    if (overwrite.type === 0 && overwrite.id === guildId) {
      everyoneAllow |= allow; everyoneDeny |= deny
    } else if (overwrite.type === 0 && assigned.has(overwrite.id)) {
      roleAllow |= allow; roleDeny |= deny
    } else if (overwrite.type === 1 && overwrite.id === botId) {
      userAllow |= allow; userDeny |= deny
    }
  }
  return (((permissions & ~everyoneDeny | everyoneAllow) & ~roleDeny | roleAllow) & ~userDeny) | userAllow
}
