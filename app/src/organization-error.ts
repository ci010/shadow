import type { MessageKey } from './i18n.ts'
export function organizationErrorMessage(code: unknown, status?: number): MessageKey {
  // A missing HTTP interface is not evidence of a model/provider failure, even
  // when an older backend or proxy returns HTML rather than a machine code.
  if (code === 'project_not_found') return 'The Project was not found. Reopen an existing Project and retry.'
  if (status === 404 || code === 'not_found') return 'The organization interface was not found. Check the request path, backend version, and proxy routing; this is not a model availability error.'
  switch (code) {
    case 'organization_disabled': return 'Topic organization is disabled. Enable it in Automations to organize topics.'
    case 'organization_already_queued': return 'Organization is already queued or running. Wait for that request to finish.'
    case 'organization_no_topics': return 'No recorded topics are available yet. Continue a conversation and retry after observation.'
    case 'organization_stopped': return 'The Project runtime stopped. Reopen the Project and retry.'
    case 'organization_network_failed': return 'The organization request could not reach the server. Check the connection and retry.'
    case 'organization_response_invalid': return 'The server returned an invalid overview. Refresh the page and check server diagnostics.'
    case 'organization_authorization_failed': return 'Permission checking failed. Refresh the page and check server diagnostics.'
    case 'work_conflict': return 'Topics changed or observation is busy. Wait for observation to finish, then retry.'
    case 'model_output_limit': return 'The model reached its output length limit. Previous results were kept; check the organization output budget or observer model.'
    case 'model_json_invalid': return 'The model returned incomplete or invalid JSON. Previous results were kept; retry, or check the observer model.'
    case 'model_schema_invalid': return 'The model returned invalid topic groups or citations. Previous results were kept; retry, or check the observer model.'
    case 'organization_cancelled': return 'Organization timed out or was cancelled. Previous results were kept; retry when the model is available.'
    case 'organization_refresh_failed': return 'Organization finished, but the overview could not be loaded. Refresh the page.'
    case 'organization_unavailable': case 'work_unavailable': return 'Topic organization is unavailable in this runtime.'
    case 'unauthorized': return 'You do not have permission to organize topics.'
    case 'invalid_request': return 'The organization request was rejected. Refresh the page and retry.'
    default: return 'Organization failed. Previous results were kept; check model availability and server diagnostics, then retry.'
  }
}

/** Only bounded machine identifiers, never server messages/provider content. */
export function organizationDiagnostic(body: unknown, status: number): string {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const token = (entry: unknown) => typeof entry === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry) ? entry : ''
  return ` [HTTP ${status}${token(value.error) ? ` · ${token(value.error)}` : ''}${token(value.stage) ? ` · ${token(value.stage)}` : ''}${token(value.correlationId) ? ` · ${token(value.correlationId)}` : ''}]`
}
