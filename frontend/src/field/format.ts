export type TrackStatus = 'live' | 'stale' | 'lost' | 'no_fix' | 'off_duty'

export const STATUS_META: Record<TrackStatus, { label: string; tone: 'green' | 'amber' | 'gray' | 'red'; hint: string }> = {
  live: { label: 'Live', tone: 'green', hint: 'Position received within the last 2 minutes' },
  stale: { label: 'Stale', tone: 'amber', hint: 'Last position is a few minutes old; the salesman may have moved' },
  lost: { label: 'Signal lost', tone: 'red', hint: 'No position for over 15 minutes' },
  no_fix: { label: 'Waiting for GPS', tone: 'gray', hint: 'On duty, but no position has arrived yet' },
  off_duty: { label: 'Off duty', tone: 'gray', hint: 'Not on a duty session. No location is recorded.' },
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`
  const km = m / 1000
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${Math.round(seconds)} s ago`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min ago` : `${h} h ago`
}

/** Age of an ISO timestamp in whole seconds relative to `nowMs` (never negative). */
export const ageSeconds = (iso: string, nowMs = Date.now()): number => Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000))

export function fmtAccuracy(m: number | null | undefined): string {
  return m === null || m === undefined ? '—' : `±${Math.round(m)} m`
}

/** Opens turn-by-turn directions (driving distance and time) in the maps app; we never guess road distance. */
export const directionsUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`

/**
 * The status a position deserves *right now*. The server reports `age_s` as of its response; the screen adds
 * the time elapsed since, so if live updates stop arriving a green marker turns amber and then grey on its own.
 */
export function statusAtAge(ageS: number, t: { live_s: number; stale_s: number }): 'live' | 'stale' | 'lost' {
  return ageS <= t.live_s ? 'live' : ageS <= t.stale_s ? 'stale' : 'lost'
}
