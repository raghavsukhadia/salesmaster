import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../auth'
import { FieldTracker } from './fieldTracker.ts'

// crypto.randomUUID only exists in secure contexts; getRandomValues works everywhere.
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// One tracker for the whole tab, so recording continues while the salesman moves between pages.
export const tracker = new FieldTracker({
  api,
  geo: typeof navigator !== 'undefined' && navigator.geolocation ? navigator.geolocation : null,
  store: localStorage,
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
  isOnline: () => navigator.onLine,
  uuid,
})

// Signing out (or a token that can no longer be refreshed) stops recording on this phone; unsent points stay queued.
window.addEventListener('sm:logout', () => tracker.shutdown())

/** Read-only view of the tracker state. */
export const useTrackerState = () => useSyncExternalStore(tracker.subscribe, tracker.getState)

/** The salesman shell owns startup and recording across every page. */
export function useFieldTracker(userId: number) {
  useEffect(() => {
    void tracker.open(userId)
    const online = () => { tracker.setOnline(true); void tracker.open(userId) }
    const offline = () => tracker.setOnline(false)
    const visible = () => { if (document.visibilityState === 'visible') void tracker.open(userId) }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
      tracker.shutdown()
    }
  }, [userId])
  return useTrackerState()
}
