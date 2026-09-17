import { shallowRef, type InjectionKey, type ShallowRef } from 'vue'
import type { IoRun } from '../../../src/io/contracts.ts'
import type { IoExecution } from './execution.ts'

export interface IoContext { apiBase: string; sessionId: string; remote: boolean; projectId?: string }
export const ioRunKey = (base: string, id: string) => JSON.stringify([base, id])
export interface IoActions {
  prepare(run: IoRun, base: string): Promise<void>
  start(id: string, base: string, inputs: Record<string, string>): void
  finish(id: string, base: string): void
  cancel(run: IoRun, base: string, denied?: boolean): Promise<void>
}
export interface IoBridge {
  context: ShallowRef<IoContext | undefined>
  views: ShallowRef<ReadonlyMap<string, IoContext>>
  runs: ShallowRef<ReadonlyMap<string, IoRun[]>>
  errors: ShallowRef<ReadonlyMap<string, string>>
  execution: ShallowRef<IoExecution | undefined>
  executionBase: ShallowRef<string>
  busy: ShallowRef<string | undefined>
  actions: ShallowRef<IoActions | undefined>
  clock: ShallowRef<number>
}
export const ioBridgeKey: InjectionKey<IoBridge> = Symbol('trusted-io-host')
export function createIoBridge(): IoBridge {
  const context = shallowRef<IoContext>()
  return {
    context, views: shallowRef(new Map()), runs: shallowRef(new Map()), errors: shallowRef(new Map()),
    execution: shallowRef(), executionBase: shallowRef(''), busy: shallowRef(), actions: shallowRef(), clock: shallowRef(Date.now()),
  }
}
