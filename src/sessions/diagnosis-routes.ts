import type { GatewayPlugin } from '../gateway/types.ts'
import { FolderError } from '../folders/registry.ts'
import { createSessionDiagnosis, DiagnosisRequestError, parseDiagnosisQuery, type DiagnosisSource } from './diagnosis.ts'

export function sessionDiagnosisPlugin(
  source: DiagnosisSource,
  options: {
    authorize: (request: Request) => boolean | Promise<boolean>
    assertAccess: (sessionId: string) => void
  },
): GatewayPlugin {
  return app => {
    app.get('/api/sessions/:key/diagnosis', async c => {
      c.header('Cache-Control', 'no-store')
      if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      try {
        const query = parseDiagnosisQuery(new URL(c.req.url).searchParams)
        const key = c.req.param('key')
        if (!await source.getState(key)) return c.json({ error: 'session_not_found' }, 404)
        options.assertAccess(key)
        return c.json(await createSessionDiagnosis(source, key, query, c.req.raw.signal))
      } catch (error) {
        if (error instanceof DiagnosisRequestError) return c.json({ error: error.message }, error.status)
        if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
        if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
        console.error('[diagnosis] Failed to collect session evidence:', error)
        return c.json({ error: 'diagnosis_collection_failed' }, 500)
      }
    })
  }
}
