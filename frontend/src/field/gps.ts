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

/** Uses the tracker's latest reading if it is fresh, otherwise asks the browser for a new one. */
export function freshReading(latest: { latitude: number; longitude: number; accuracy_m: number; t: number } | null): Promise<Reading> {
  if (latest && isFresh(latest.t)) {
    return Promise.resolve(toReading({ latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy_m, timestamp: latest.t }))
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new GpsError('unsupported'))
    navigator.geolocation.getCurrentPosition(
      (p) => (isFresh(p.timestamp) ? resolve(toReading({ ...p.coords, timestamp: p.timestamp })) : reject(new GpsError('stale'))),
      (e) => reject(new GpsError(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    )
  })
}
