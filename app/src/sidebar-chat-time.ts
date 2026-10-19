/** Relative for the last four days, an unambiguous local calendar date thereafter. */
export function formatSidebarActivity(value: string | undefined, now: number, locale: string): string {
  const timestamp = value ? Date.parse(value) : NaN
  if (!Number.isFinite(timestamp)) return ''
  // Clock skew must not produce misleading future activity labels.
  const age = Math.max(0, now - timestamp)
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (age < 60_000) return relative.format(0, 'second')
  if (age < 3_600_000) return relative.format(-Math.floor(age / 60_000), 'minute')
  if (age < 86_400_000) return relative.format(-Math.floor(age / 3_600_000), 'hour')
  if (age < 4 * 86_400_000) return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-Math.floor(age / 86_400_000), 'day')
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp)
}
