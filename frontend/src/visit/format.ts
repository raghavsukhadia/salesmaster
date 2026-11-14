// Display helpers shared by the salesman screens.

/** "14:05" -> "2:05 pm". Anything that is not HH:MM (including null) gives ''. The server sends a plain time of day, never a timezone. */
export function fmtClock(t?: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '')
  if (!m) return ''
  const h = Number(m[1])
  const mins = m[2]
  if (h > 23 || Number(mins) > 59) return ''
  return `${h % 12 || 12}:${mins} ${h < 12 ? 'am' : 'pm'}`
}

/** "5 Dec 2026, 2:05 pm" or just the date when there is no time. Takes the date as YYYY-MM-DD. */
export function fmtDue(date: string, time?: string | null): string {
  const day = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const clock = fmtClock(time)
  return clock ? `${day}, ${clock}` : day
}

export type VisitStatus = 'order' | 'followup' | 'visited'

/** The server derives a visit's status from its order and follow-ups; this is how each one reads and what colour it gets. */
export const VISIT_STATUS: Record<VisitStatus, { label: string; tone: 'green' | 'amber' | 'gray' }> = {
  order: { label: 'Order placed', tone: 'green' },
  followup: { label: 'Follow-up pending', tone: 'amber' },
  visited: { label: 'Visited', tone: 'gray' },
}

export const visitStatus = (s: string) => VISIT_STATUS[s as VisitStatus] ?? VISIT_STATUS.visited

/** Today in the browser's local time as YYYY-MM-DD (toISOString would give the UTC day, wrong for the first hours of an IST morning). */
export const localDate = (offsetDays = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
