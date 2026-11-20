import { buildPlayground, PlaygroundError, type PlaygroundSnapshot } from '@shadow/three-playground'

// Only the trusted build driver runs in this Worker. User code is evaluated by
// QuickJS, not by the browser's JS engine. One worker, snapshot and VM per build.
self.onmessage = async ({ data }: MessageEvent<PlaygroundSnapshot>) => {
  try {
    const { glb } = await buildPlayground(data, { timeoutMs: 8000 })
    self.postMessage({ glb }, { transfer: [glb] })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Build failed'
    self.postMessage({ error: [message, error instanceof PlaygroundError && error.guestStack].filter(Boolean).join('\n').slice(0, 8192) })
  }
}
