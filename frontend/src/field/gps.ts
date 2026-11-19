// A single fresh GPS reading for a check-in / check-out. Pure helpers + one thin browser call.

export interface Reading { latitude: number; longitude: number; accuracy_m: number; captured_at: string }

export const FRESH_MS = 15_000 // the server wants a reading from the last 2 minutes; we insist on much fresher

/** A reading taken `t` (epoch ms) is usable as "now" only if it is recent. */
export const isFresh = (t: number, now = Date.now(), maxAgeMs = FRESH_MS): boolean => now - t >= -5_000 && now - t <= maxAgeMs

export const toReading = (p: { latitude: number; longitude: number; accuracy: number; timestamp: number }): Reading => ({
  latitude: Math.round(p.latitude * 1e6) / 1e6,
  longitude: Math.round(p.longitude * 1e6) / 1e6,
  accuracy_m: Math.round(p.accuracy * 10) / 10,
  captured_at: new Date(p.timestamp).toISOString(),
})

export class GpsError extends Error {
  kind: 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'stale'
  constructor(kind: GpsError['kind']) {
    super(kind)
    this.kind = kind
  }
}

export const gpsMessage = (e: unknown): string => {
  switch ((e as GpsError)?.kind) {
    case 'denied': return 'Location access is blocked. Allow it in your browser settings and try again.'
    case 'unsupported': return 'This browser cannot provide your location.'
    case 'timeout': return 'Could not get a GPS position in time. Move near a window or outdoors and try again.'
    case 'stale': return 'The phone only had an old location reading. Wait a few seconds and try again.'
    default: return 'Your location is unavailable right now. Check that Location is switched on.'
  }
}

/** A fix this good (metres) is taken the moment it arrives. Anything rougher gets a few seconds to improve. */
export const GOOD_FIX_M = 100

/**
 * "Where am I right now", as fast as the phone can say. Used by the Record Visit "Detect current location" button.
 *
 * It asks for a quick network fix and a GPS fix at the same time, and accepts a position the browser already has from the
 * last 10 seconds (the duty tracker keeps it warm), so a cold GPS start no longer holds the button up. The first fix at or
 * better than `goodFixM` is returned at once; a rougher one waits at most `settleMs` for something better and the best
 * fix seen is returned. Nothing older than 15 seconds is ever accepted. Rejects with a GpsError if no usable fix arrives
 * within `hardMs`, or at once if location is blocked.
 */
export function quickReading(opts: { goodFixM?: number; settleMs?: number; hardMs?: number; latest?: { latitude: number; longitude: number; accuracy_m: number; t: number } | null } = {}): Promise<Reading> {
  const { goodFixM = GOOD_FIX_M, settleMs = 1_500, hardMs = 15_000, latest } = opts
  // The duty tracker's own latest fix: when it is fresh and good there is nothing to wait for.
  const seed = latest && isFresh(latest.t) ? toReading({ latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy_m, timestamp: latest.t }) : null
  if (seed && seed.accuracy_m <= goodFixM) return Promise.resolve(seed)
  return new Promise((resolve, reject) => {
    const geo = typeof navigator === 'undefined' ? undefined : navigator.geolocation
    if (!geo) return seed ? resolve(seed) : reject(new GpsError('unsupported'))

    let best: Reading | null = seed
    let sawStale = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const ids: number[] = []
    const failed = new Map<number, GpsError['kind']>()

    const stop = () => { clearTimeout(hard); clearTimeout(settle); ids.forEach((id) => geo.clearWatch(id)) }
    const finish = () => { stop(); resolve(best!) }
    const fail = (kind: GpsError['kind']) => { stop(); reject(new GpsError(kind)) }
    const hard = setTimeout(() => (best ? finish() : fail(sawStale ? 'stale' : 'timeout')), hardMs)
    if (seed) settle = setTimeout(finish, settleMs) // a rough tracker fix: give the phone a moment to better it

    const onPosition = (p: GeolocationPosition) => {
      if (!isFresh(p.timestamp)) { sawStale = true; return }
      // Read each field by name: a browser's coordinates are getters on a prototype, which `{ ...p.coords }` would not copy.
      const r = toReading({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp })
      if (!best || r.accuracy_m < best.accuracy_m) best = r
      if (best.accuracy_m <= goodFixM) return finish()
      settle ??= setTimeout(finish, settleMs)
    }

    const onError = (watch: number) => (e: GeolocationPositionError) => {
      const kind = e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable'
      if (kind === 'denied') return best ? finish() : fail('denied')
      failed.set(watch, kind)
      if (failed.size === 2) best ? finish() : fail(sawStale ? 'stale' : [...failed.values()].includes('unavailable') ? 'unavailable' : 'timeout')
    }

    ;[true, false].forEach((enableHighAccuracy, i) => {
      ids.push(geo.watchPosition(onPosition, onError(i), { enableHighAccuracy, maximumAge: FRESH_MS, timeout: hardMs }))
    })
  })
}

/** Uses the tracker's latest reading if it is fresh, otherwise asks the browser for a new one. */
export function freshReading(latest: { latitude: number; longitude: number; accuracy_m: number; t: number } | null): Promise<Reading> {
  if (latest && isFresh(latest.t)) {
    return Promise.resolve(toReading({ latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy_m, timestamp: latest.t }))
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new GpsError('unsupported'))
    navigator.geolocation.getCurrentPosition(
      // Fields read by name: a browser's coordinates are prototype getters, so `{ ...p.coords }` would come out empty (NaN).
      (p) => (isFresh(p.timestamp) ? resolve(toReading({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp })) : reject(new GpsError('stale'))),
      (e) => reject(new GpsError(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    )
  })
}
