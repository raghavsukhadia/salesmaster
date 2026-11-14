// Offline GPS queue. Pure functions over an injectable Storage so they are unit-testable with `node --test`.
//
// Contract with the server (POST /api/field/locations/): a 200 means every point in the batch was judged
// (accepted, duplicate, or permanently rejected), so the whole batch leaves the queue. A network failure,
// 429 or 5xx keeps it. A 400 means the batch itself is malformed and can never succeed, so it is discarded.

export interface QueuedPoint {
  client_point_id: string
  latitude: number
  longitude: number
  accuracy_m: number
  captured_at: string // ISO-8601 UTC
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const MAX_QUEUE = 2000 // ~5.5 hours at one fix per 10 s; the oldest fixes are dropped first
export const MAX_BATCH = 100 // the server accepts up to 200 per request

const isPoint = (p: unknown): p is QueuedPoint => {
  const o = p as Record<string, unknown> | null
  return !!o && typeof o.client_point_id === 'string' && typeof o.latitude === 'number' && typeof o.longitude === 'number'
    && typeof o.accuracy_m === 'number' && typeof o.captured_at === 'string'
}

export function loadQueue(store: KeyValueStore, key: string): QueuedPoint[] {
  try {
    const raw = store.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isPoint) : []
  } catch {
    return [] // corrupted or unavailable storage must never break tracking
  }
}

/** Returns false if the browser refused the write (quota / private mode). */
export function saveQueue(store: KeyValueStore, key: string, queue: QueuedPoint[]): boolean {
  try {
    if (queue.length === 0) store.removeItem(key)
    else store.setItem(key, JSON.stringify(queue))
    return true
  } catch {
    return false
  }
}

export function enqueue(queue: QueuedPoint[], point: QueuedPoint, max = MAX_QUEUE): { queue: QueuedPoint[]; dropped: number } {
  if (queue.some((q) => q.client_point_id === point.client_point_id)) return { queue, dropped: 0 }
  const next = [...queue, point]
  const dropped = Math.max(0, next.length - max)
  return { queue: dropped ? next.slice(dropped) : next, dropped }
}

export const nextBatch = (queue: QueuedPoint[], size = MAX_BATCH): QueuedPoint[] => queue.slice(0, size)

export function removeSent(queue: QueuedPoint[], sent: QueuedPoint[]): QueuedPoint[] {
  const gone = new Set(sent.map((p) => p.client_point_id))
  return queue.filter((p) => !gone.has(p.client_point_id))
}

/** Seconds to wait before the next upload attempt after `failures` consecutive failures. */
export const backoffSeconds = (failures: number, base = 5, cap = 300): number =>
  failures <= 0 ? 0 : Math.min(cap, base * 2 ** (failures - 1))

// ---- sampling -------------------------------------------------------------------------------------

export interface Fix { latitude: number; longitude: number; accuracy_m: number; t: number /* epoch ms */ }

const R = 6_371_008.8
export function distanceM(a: Pick<Fix, 'latitude' | 'longitude'>, b: Pick<Fix, 'latitude' | 'longitude'>): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Whether a fresh browser fix should be recorded. A heartbeat every `intervalS`, plus an early record when
 * the salesman has clearly moved, so a drive is not reduced to a few dots. Fixes the server would reject
 * anyway (worse than `maxAccuracyM`) are never recorded.
 */
export function shouldRecord(
  last: Fix | null, next: Fix, intervalS: number, opts: { moveM?: number; minGapS?: number; maxAccuracyM?: number } = {},
): boolean {
  const { moveM = 100, minGapS = 5, maxAccuracyM = 1000 } = opts
  if (!(next.accuracy_m <= maxAccuracyM)) return false
  if (!last) return true
  const gapS = (next.t - last.t) / 1000
  if (gapS < 0) return false
  if (gapS >= intervalS) return true
  return gapS >= minGapS && distanceM(last, next) >= moveM
}
