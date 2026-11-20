import { captureId, parseCaptureView } from '../gltf-capture-contract.ts'
import type { GltfCaptureBridge } from '../gateway/gltf-capture.ts'
import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import type { ExecutionContext } from './context.ts'
import { transientToolResult, type Tool, type ToolParameters, type ToolResult } from './tool.ts'

export class CaptureViewTool implements Tool<ToolResult> {
  readonly name = 'capture_view'
  readonly description = 'Capture the glTF Viewer explicitly bound to this owner Web turn. Use the exact assetId. Omit version to use the current loaded asset version, or specify the expected version to reject a mismatch. After editing a file, use afterVersion with the previously observed version to prevent capturing the old render before reload. current reads its canvas; front/back/top/custom capture an independent camera without changing the Viewer. No file or arbitrary tab capture.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false,
    properties: {
      assetId: { type: 'string' }, version: { type: 'string', description: 'Optional expected asset version; omit to capture the currently loaded version.' },
      afterVersion: { type: 'string', description: 'Reject while the Viewer still shows this previous version. Wait for reload, then retry.' },
      mode: { type: 'string', enum: ['current', 'front', 'back', 'top', 'custom'] },
      position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Custom camera position [x,y,z].' },
      target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Custom camera target [x,y,z].' },
    }, required: ['assetId', 'mode'],
  }
  readonly supportsLayerFSWorkdir = true

  constructor(private readonly projectId: string, private readonly bridge: GltfCaptureBridge) {}

  available(ctx: ExecutionContext) {
    return ctx.projectId === this.projectId && !ctx.remoteWorkdir && ctx.workUserInput !== undefined && isDirectOwnerTurn(ctx) &&
      this.bridge.available(ctx.sessionId, ctx.messageId)
  }

  async execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (!this.available(ctx)) return 'Error: capture_view requires a live Viewer binding from this direct owner Web turn.'
    const { assetId, version, afterVersion } = args
    const view = parseCaptureView(args)
    if (!view || !captureId(assetId) || (version !== undefined && !captureId(version)) || (afterVersion !== undefined && !captureId(afterVersion))) return 'Error: provide the exact assetId, a valid camera mode, and optionally an expected version.'
    try {
      const { mimeType, data, camera, objectIds, version: capturedVersion } = await this.bridge.capture({ projectId: this.projectId,
        sessionId: ctx.sessionId, assetId, version, afterVersion }, ctx.messageId, view, ctx.signal)
      return transientToolResult([
        { type: 'text', text: JSON.stringify({ assetId, version: capturedVersion, mode: view.mode, camera, objectIds }) },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}`, detail: 'auto' } },
      ], 'Observed the bound glTF Viewer (transient image).')
    } catch (error) {
      ctx.signal.throwIfAborted()
      return `Error: ${error instanceof Error ? error.message : 'Viewer capture failed.'}`
    }
  }
}
