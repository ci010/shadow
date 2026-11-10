import type { ImportTool } from './load-tool.ts'
import type { SignalProviderTool } from './signal-provider.ts'

/** External acquisition/distribution discovery; independent of the runtime event bus. */
export function registerSignalTools(importer: Pick<ImportTool, 'registerBuiltin'>, provider: SignalProviderTool): void {
  importer.registerBuiltin(provider.name, provider)
  importer.registerBuiltin('signals', { contracts: [provider], factory: async () => [provider] })
}
