/** Document success is insufficient: wait for the remote app's bootstrap IPC handshake. */
export class RendererReadiness {
  failed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly onFailure: () => void, private readonly timeoutMs = 20000) {}
  wait(): void {
    this.ready()
    this.timer = setTimeout(() => { this.failed = true; this.onFailure() }, this.timeoutMs)
  }
  ready(): void { clearTimeout(this.timer); this.timer = undefined }
  fail(): void { this.ready(); this.failed = true }
  retry(): void { this.failed = false }
}
