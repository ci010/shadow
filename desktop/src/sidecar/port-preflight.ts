import { createConnection } from 'node:net'

/** Detect an existing loopback listener without sending credentials or touching its runtime. */
export function isLoopbackPortOccupied(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied: boolean) => {
      socket.destroy()
      resolve(occupied)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}
