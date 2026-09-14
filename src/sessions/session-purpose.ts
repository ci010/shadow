// startSession uses heartbeat:<agentType>-<timestamp>; display titles are mutable.
export function isSelfReflectionId(id: string): boolean {
  return /^heartbeat:(?:soul-)?reflector-.+/.test(id)
}
