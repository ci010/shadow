import WebSocket from 'ws'

/** Bounded duplex bridge; neither queued frames nor half-open sockets survive a peer. */
export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  let queued = 0
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
  const stop = () => { client.terminate(); upstream.terminate() }
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      queued += Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length
      if (queued > 1024 * 1024) { stop(); return }
      pending.push({ data, binary })
    } else if (upstream.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount > 1024 * 1024) stop()
      else upstream.send(data, { binary })
    }
  })
  upstream.on('open', () => { for (const { data, binary } of pending.splice(0)) upstream.send(data, { binary }); queued = 0 })
  upstream.on('message', (data, binary) => {
    if (client.bufferedAmount > 1024 * 1024) stop()
    else if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
  })
  client.once('close', () => upstream.terminate())
  upstream.once('close', () => client.close())
  client.once('error', stop)
  upstream.once('error', stop)
}
