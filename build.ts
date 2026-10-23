import { buildBackend } from './scripts/backend-build.ts'

await buildBackend(process.cwd())
console.log('Built Node backend: dist/src/index.js')
