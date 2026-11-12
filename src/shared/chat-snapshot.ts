/** Fixed-size direct-chat metadata protocol. Values are whole-field replacements,
 * including empty strings/arrays. Identity is always sent and binds every hash. */
export const chatMetadataFields = ['systemPrompt', 'tools', 'commandResults', 'decisionRecords'] as const
export type ChatMetadataVersions = Record<typeof chatMetadataFields[number], string>
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const isRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function isChatMetadataVersions(value: unknown): value is ChatMetadataVersions {
  return isRecord(value) && Object.keys(value).length === chatMetadataFields.length
    && chatMetadataFields.every(field => isRevision(value[field]))
}
export function validChatMetadata(value: Record<string, unknown>): boolean {
  return typeof value.systemPrompt === 'string' && Array.isArray(value.tools)
    && Array.isArray(value.commandResults) && Array.isArray(value.decisionRecords)
}
