import { manageChildren, startNode } from './processes.ts'

const port = process.env.VITE_DEV_PORT ?? '5273'
const children = [
  startNode([
    '--env-file-if-exists=.env', '--import', 'tsx', '--inspect', '--watch',
    'src/index.ts',
  ], { env: { VITE_DEV_URL: `http://127.0.0.1:${port}` } }),
  startNode([
    'node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
    '--port', port, '--strictPort',
  ], { cwd: 'app' }),
]

await manageChildren(children).wait()
