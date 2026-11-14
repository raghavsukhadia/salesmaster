import { useEffect, useState } from 'react'
import { api } from '../auth'

export interface FollowupSummary {
  pending: number
  due_today: number
  overdue: number
  /** Due today plus overdue: what the sidebar badge shows. Upcoming follow-ups are not "needs attention" yet. */
  attention: number
}

/** Fired after anything changes a follow-up (create, complete, reschedule, cancel, a visit that schedules one) so the badge updates at once. */
const CHANGED = 'sm:followups-changed'
export const notifyFollowupsChanged = () => window.dispatchEvent(new Event(CHANGED))

const REFRESH_MS = 60_000

/** Live follow-up counts for the signed-in salesman, or null until the first answer (or when disabled / the call fails). */
export function useFollowupSummary(enabled: boolean, routeKey: string): FollowupSummary | null {
  const [summary, setSummary] = useState<FollowupSummary | null>(null)

  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = () => {
      api<FollowupSummary>('/api/salesman/followups/summary/')
        .then((s) => { if (live) setSummary(s) })
        .catch(() => { /* a badge that cannot refresh keeps its last value; the Follow-ups page shows the real error */ })
    }
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    load()
    const timer = setInterval(load, REFRESH_MS)
    window.addEventListener(CHANGED, load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener(CHANGED, load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, routeKey]) // routeKey: re-check whenever the salesman moves between screens

  return enabled ? summary : null
}
