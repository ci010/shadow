/* Same-origin Vite asset. No blob URLs, eval, network or playback. */
class ShadowPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.length = 0
    this.closed = false
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        if (this.length) this.port.postMessage({ samples: this.buffer.slice(0, this.length) })
        this.closed = true
        this.port.postMessage({ stopped: true })
      }
    }
  }
  process(inputs) {
    if (this.closed) return false
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (const channel of channels) sample += channel[i] || 0
      this.buffer[this.length++] = sample / channels.length
      if (this.length === this.buffer.length) {
        const samples = this.buffer
        this.port.postMessage({ samples }, [samples.buffer])
        this.buffer = new Float32Array(2048)
        this.length = 0
      }
    }
    return true
  }
}
registerProcessor('shadow-pcm-capture', ShadowPcmCapture)
