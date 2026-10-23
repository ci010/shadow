import { ensureDevelopmentSafegit } from './development-safegit.ts'

await ensureDevelopmentSafegit(process.cwd())
await import('../src/index.ts')
