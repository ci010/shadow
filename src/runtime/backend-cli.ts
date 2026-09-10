export interface BackendCliArguments {
  readonly configPath?: string
}

export type BackendSignal = 'SIGINT' | 'SIGTERM'

export interface BackendRuntimeLifecycle {
  shutdown(): Promise<void>
}

export interface BackendProcessHooks {
  readonly argv: readonly string[]
  on(signal: BackendSignal, listener: () => void): void
  off(signal: BackendSignal, listener: () => void): void
  exit(code: number): void
}

export function parseBackendCliArguments(
  argv: readonly string[],
): BackendCliArguments {
  const configArg = argv[2]
  return {
    configPath: configArg && !configArg.startsWith('-') ? configArg : undefined,
  }
}

export function attachBackendSignalHandlers(
  runtime: BackendRuntimeLifecycle,
  hooks: BackendProcessHooks,
  options: { readonly includeSigterm: boolean },
): () => void {
  const onSignal = () => {
    runtime.shutdown().then(
      () => hooks.exit(0),
      () => hooks.exit(1),
    )
  }
  const signals: BackendSignal[] = options.includeSigterm
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT']
  for (const signal of signals) hooks.on(signal, onSignal)

  return () => {
    for (const signal of signals) hooks.off(signal, onSignal)
  }
}
