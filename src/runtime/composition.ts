import type {
  BootstrapConfigV1,
  ChildBootstrapConfigV1,
  MainBootstrapConfigV1,
} from './bootstrap-config.ts'

export interface PlannedService<Name extends string> {
  readonly name: Name
}

export interface LocalExecutorRuntimeServices {
  readonly nodeIdentity: PlannedService<'node-identity'>
  readonly capabilityRegistry: PlannedService<'capability-registry'>
  readonly executors: PlannedService<'local-executors'>
  readonly approvalService: PlannedService<'approval-service'>
  readonly artifactStaging: PlannedService<'artifact-staging'>
}

export interface MainRuntimeServices {
  readonly providers: PlannedService<'providers'>
  readonly sessions: PlannedService<'sessions'>
  readonly memory: PlannedService<'memory'>
  readonly wiki: PlannedService<'wiki'>
  readonly skills: PlannedService<'skills'>
  readonly agentDefinitions: PlannedService<'agent-definitions'>
  readonly channels: PlannedService<'channels'>
  readonly cron: PlannedService<'cron'>
  readonly events: PlannedService<'events'>
  readonly vfs: PlannedService<'vfs'>
  readonly durableStores: PlannedService<'durable-stores'>
  readonly clusterListener: PlannedService<'cluster-listener'>
  readonly nodeRegistry: PlannedService<'node-registry'>
  readonly localExecutor?: LocalExecutorRuntimeServices
}

export interface ChildRuntimeServices extends LocalExecutorRuntimeServices {
  readonly mainConnector: PlannedService<'main-connector'>
  readonly remoteApiProxy: PlannedService<'remote-api-proxy'>
}

export interface MainRuntimePlan {
  readonly phase: 'composition-planned'
  readonly mode: 'main'
  readonly config: MainBootstrapConfigV1
  readonly services: MainRuntimeServices
}

export interface ChildRuntimePlan {
  readonly phase: 'composition-planned'
  readonly mode: 'child'
  readonly config: ChildBootstrapConfigV1
  readonly services: ChildRuntimeServices
}

export type RuntimeCompositionPlan = MainRuntimePlan | ChildRuntimePlan

export interface MainCompositionOptions {
  readonly localExecutor?: boolean
}

export function planRuntimeComposition(
  config: BootstrapConfigV1,
  options: MainCompositionOptions = {},
): RuntimeCompositionPlan {
  if (config.mode === 'child') {
    if (options.localExecutor !== undefined) {
      throw new Error('localExecutor is a Main-only composition option')
    }
    return {
      phase: 'composition-planned',
      mode: 'child',
      config,
      services: {
        mainConnector: service('main-connector'),
        remoteApiProxy: service('remote-api-proxy'),
        ...localExecutorServices(),
      },
    }
  }

  return {
    phase: 'composition-planned',
    mode: 'main',
    config,
    services: {
      providers: service('providers'),
      sessions: service('sessions'),
      memory: service('memory'),
      wiki: service('wiki'),
      skills: service('skills'),
      agentDefinitions: service('agent-definitions'),
      channels: service('channels'),
      cron: service('cron'),
      events: service('events'),
      vfs: service('vfs'),
      durableStores: service('durable-stores'),
      clusterListener: service('cluster-listener'),
      nodeRegistry: service('node-registry'),
      ...(options.localExecutor
        ? { localExecutor: localExecutorServices() }
        : {}),
    },
  }
}

function localExecutorServices(): LocalExecutorRuntimeServices {
  return {
    nodeIdentity: service('node-identity'),
    capabilityRegistry: service('capability-registry'),
    executors: service('local-executors'),
    approvalService: service('approval-service'),
    artifactStaging: service('artifact-staging'),
  }
}

function service<const Name extends string>(name: Name): PlannedService<Name> {
  return { name }
}
