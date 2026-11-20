import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { candidateSchema } from './assessment.ts'
import { setupSchema } from './install.ts'
import { remoteSchema } from './remote.ts'
import { AudioCppService } from './service.ts'

const task = z.enum(['asr', 'tts'])
const configure = z.object({ binary: z.string().optional(), task: task.optional(), family: z.string().optional(), path: z.string().optional(), backend: z.string().optional(), options: z.array(z.string()).optional() }).strict()

/** Host process only: not registered with the agent, HTTP or realtime tool gateways. */
export async function runProjectAudioCli(args: readonly string[], open = (home: string) => new AudioCppService(home)): Promise<unknown> {
  const [command, home, ...params] = args
  if (!home || !isAbsolute(home) || !(await stat(home)).isDirectory()) {
    throw new Error('Provide the absolute path of the existing Project Home on this host.')
  }
  const audio = open(home)
  const [file, output] = params
  const json = async () => {
    if (!file || params.length !== 1) throw new Error('Provide one JSON settings file.')
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  }
  switch (command) {
    case 'status':
      if (!params.length) return audio.status()
      break
    case 'assess': return audio.assess(candidateSchema.parse(await json()))
    case 'configure': return audio.configure(configure.parse(await json()))
    case 'install': return audio.setup(setupSchema.parse(await json()))
    case 'configure-remote': {
      const config = z.object({ task, remote: remoteSchema }).strict().parse(await json())
      return audio.configureRemote(config.task, config.remote)
    }
    case 'transcribe':
      if (file && params.length === 1) return { text: await audio.transcribe(file) }
      break
    case 'speak':
      if (file && output && params.length === 2) return { path: await audio.speak(await readFile(file, 'utf8'), output) }
      break
  }
  throw new Error('Usage: project-audio <status|assess|configure|install|configure-remote|transcribe|speak> <Project Home> [settings JSON | input file [output.wav]]')
}
