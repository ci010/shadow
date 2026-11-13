import { t } from './i18n.ts'

/** Use only exact units; unfamiliar schedules remain verbatim. No timezone is inferred. */
export function formatWorkflowSchedule(schedule: string): string {
  const interval = /^every\s*(\d+)\s*(ms|s|m|h|d)$/i.exec(schedule.trim())
  if (interval) {
    const scales: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
    const ms = Number(interval[1]) * scales[interval[2]!.toLowerCase()]!
    if (Number.isSafeInteger(ms) && ms > 0) {
      const units = [[86400000, 'Every {count} days'], [3600000, 'Every {count} hours'], [60000, 'Every {count} minutes'], [1000, 'Every {count} seconds'], [1, 'Every {count} milliseconds']] as const
      for (const [scale, key] of units) if (ms % scale === 0) return t(key, { count: ms / scale }, ms / scale)
    }
    return schedule
  }
  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(schedule.trim())
  if (daily && Number(daily[1]) < 60 && Number(daily[2]) < 24) return t('Daily at {time}', { time: `${daily[2]!.padStart(2, '0')}:${daily[1]!.padStart(2, '0')}` })
  return schedule
}
