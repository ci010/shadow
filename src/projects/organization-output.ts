/** Safe error labels only: provider output and validation values can contain private evidence. */
export class OrganizationOutputError extends Error {
  constructor(readonly code: 'model_json_invalid' | 'model_schema_invalid' | 'model_output_limit') {
    super(code)
    this.name = 'OrganizationOutputError'
  }
}

/** Execution results cross persistence: classify only exact known safe failure strings. */
export function organizationExecutionError(message?: string): Error {
  if (message === 'Responses request incomplete: max_output_tokens') return new OrganizationOutputError('model_output_limit')
  return new Error('Work organization did not complete.')
}
