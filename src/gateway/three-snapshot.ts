import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { readThreeSnapshot, ThreeSnapshotError } from '../execution/filesystem/three-snapshot.ts'

export type ThreeRoot = { path: string } | { error: string; status: 400 | 403 | 404 | 409 | 500 | 501 | 503; message?: string }

const messages: Record<string, string> = {
  snapshot_changed_retry: 'An input changed during the snapshot. Retry the request.',
  invalid_snapshot_path: 'Expected a safe relative path with a supported file type.',
  unsafe_snapshot_file: 'Expected ordinary directories and a regular, non-linked file.',
  snapshot_file_unavailable: 'The declared file could not be opened.',
  snapshot_size_limit: 'An input exceeds its file or aggregate byte limit.',
  snapshot_shader_text_limit: 'A shader source exceeds 32,768 UTF-16 code units.',
  snapshot_count_limit: 'The marker declares too many inputs.',
  invalid_utf8: 'Expected valid UTF-8 source text.',
  snapshot_root_unavailable: 'The authorized snapshot root is unavailable.',
  snapshot_cancelled: 'The snapshot request was cancelled.',
  invalid_snapshot_preview: 'Expected preview settings with optional toneMapping (none or aces) and exposure (a finite number from 0.1 to 4).',
  invalid_snapshot_marker: 'Invalid manifest. List main.mjs and explicit inputs, with unique module paths, asset paths, and shader slots.',
}

export async function serveThreeSnapshot(c: Context, resolveRoot: () => Promise<ThreeRoot>): Promise<Response> {
  c.header('Cache-Control', 'private, no-store')
  const id = randomUUID()
  try {
    const root = await resolveRoot()
    if ('error' in root) return c.json({ error: root.error, message: root.message, id }, root.status)
    const result = await readThreeSnapshot(root.path, c.req.query('path'), c.req.header('If-None-Match'), c.req.raw.signal)
    const json = result.snapshot && JSON.stringify(result.snapshot)
    if (json && Buffer.byteLength(json) > 8 * 1024 * 1024) {
      return c.json({ error: 'snapshot_response_size_limit', message: 'Encoded snapshot exceeds 8 MiB.', id }, 413)
    }
    c.header('ETag', result.etag)
    return json ? c.body(json, 200, { 'Content-Type': 'application/json; charset=UTF-8' }) : c.body(null, 304)
  } catch (error) {
    if (error instanceof ThreeSnapshotError) {
      return c.json({ error: error.code, message: messages[error.code] ?? error.code, file: error.file, id }, error.status)
    }
    return c.json({ error: 'snapshot_unavailable', message: 'Could not access the authorized snapshot root.', id }, 503)
  }
}
