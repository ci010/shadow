import { runVideoCli } from '../src/video/cli.ts'
const controller = new AbortController()
const abort = () => controller.abort(new Error('Video command interrupted'))
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
try { console.log(JSON.stringify(await runVideoCli(process.argv.slice(2), { signal: controller.signal }), null, 2)) }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
