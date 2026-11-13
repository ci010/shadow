// Save this resource to a local .mjs file; execute using runtime_context's launcher.
// Official SDK Init only: no Git, Docker build, credential handling or hidden restore.
import { setTimeout } from 'node:timers/promises'

export default async function main({ runtime, open, args }) {
  const [project, source, image, repository, commit] = args
  if (!project || !source || !/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !repository || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw Error('Arguments: official-project absolute-source image-id repository-https-url commit-sha')
  }
  const job = await runtime.project.start_init(project, source, { image, timeout: 1800000 })
  console.log(JSON.stringify({ jobId: job.id, project }))
  for (;;) {
    const state = await runtime.project.get_init(job.id)
    console.log(JSON.stringify(state))
    if (!state) throw Error('Init state unavailable; outcome unknown, do not replay')
    if (state.step === 'failed') throw Error('Official Init failed: ' + JSON.stringify(state.error))
    if (state.step === 'done') break
    await setTimeout(1000)
  }
  const client = await open(project)
  try {
    let offset = 0
    for (;;) {
      const page = await client.project.list_branches(100, offset)
      const main = page.items.find(branch => branch.name === 'main')
      if (main) {
        if (typeof main.base !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(main.base)) throw Error('Missing immutable main Layer identity')
        console.log(JSON.stringify({ layerfsProject: project, baselineRef: main.base, image, source: { repository, commit } }))
        return
      }
      if (!page.hasMore || !Number.isSafeInteger(page.nextPagePos) || page.nextPagePos <= offset) throw Error('Official main baseline not found')
      offset = page.nextPagePos
    }
  } finally { await client.close() }
}
