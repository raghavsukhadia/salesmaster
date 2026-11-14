/// <reference types="node" />
// Run with: npm test   (node --test, native TypeScript type stripping; no extra dependencies)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directionsUrl, fmtAccuracy, fmtAge, fmtDistance, ageSeconds, STATUS_META, statusAtAge } from './format.ts'
import {
  backoffSeconds, distanceM, enqueue, loadQueue, MAX_BATCH, nextBatch, removeSent, saveQueue, shouldRecord,
  type Fix, type KeyValueStore, type QueuedPoint,
} from './queue.ts'

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>()
  fail = false
  getItem = (k: string) => this.data.get(k) ?? null
  setItem = (k: string, v: string) => { if (this.fail) throw new Error('QuotaExceededError'); this.data.set(k, v) }
  removeItem = (k: string) => { this.data.delete(k) }
}

const pt = (n: number): QueuedPoint => ({
  client_point_id: `id-${n}`, latitude: 18.5, longitude: 73.8, accuracy_m: 10, captured_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
})
const fix = (over: Partial<Fix> = {}): Fix => ({ latitude: 18.5204, longitude: 73.8567, accuracy_m: 10, t: 1_700_000_000_000, ...over })

test('queue survives a reload and ignores corrupted storage', () => {
  const s = new MemoryStore()
  assert.deepEqual(loadQueue(s, 'k'), [])
  assert.equal(saveQueue(s, 'k', [pt(1), pt(2)]), true)
  assert.deepEqual(loadQueue(s, 'k'), [pt(1), pt(2)])
  s.setItem('k', '{not json')
  assert.deepEqual(loadQueue(s, 'k'), [])
  s.setItem('k', JSON.stringify([pt(1), { client_point_id: 5 }, null, 'x']))
  assert.deepEqual(loadQueue(s, 'k'), [pt(1)]) // malformed entries are dropped, good ones kept
})

test('saving an empty queue clears the key and a full disk is reported, not thrown', () => {
  const s = new MemoryStore()
  saveQueue(s, 'k', [pt(1)])
  saveQueue(s, 'k', [])
  assert.equal(s.getItem('k'), null)
  s.fail = true
  assert.equal(saveQueue(s, 'k', [pt(1)]), false)
})

test('enqueue drops the oldest points when full and ignores a repeated id', () => {
  let q: QueuedPoint[] = []
  for (let i = 1; i <= 5; i++) q = enqueue(q, pt(i), 3).queue
  assert.deepEqual(q.map((p) => p.client_point_id), ['id-3', 'id-4', 'id-5'])
  const again = enqueue(q, pt(5), 3)
  assert.equal(again.queue.length, 3)
  assert.equal(again.dropped, 0)
  assert.equal(enqueue([pt(1), pt(2), pt(3)], pt(4), 3).dropped, 1)
})

test('batches are oldest-first and capped; sent points leave the queue, unsent ones stay', () => {
  const q = Array.from({ length: 250 }, (_, i) => pt(i + 1))
  const batch = nextBatch(q)
  assert.equal(batch.length, MAX_BATCH)
  assert.equal(batch[0].client_point_id, 'id-1')
  const rest = removeSent(q, batch)
  assert.equal(rest.length, 150)
  assert.equal(rest[0].client_point_id, 'id-101')
  assert.equal(removeSent(q, []).length, 250)
})

test('backoff grows, then caps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffSeconds(n)), [0, 5, 10, 20, 40, 80, 160, 300, 300])
})

test('distance is metric and symmetric', () => {
  assert.ok(Math.abs(distanceM({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }) - 111_195) < 50)
  const a = fix(), b = fix({ latitude: 18.53 })
  assert.equal(distanceM(a, b), distanceM(b, a))
  assert.equal(distanceM(a, a), 0)
})

test('sampling: first fix, heartbeat, early record on movement, and rejection of useless fixes', () => {
  assert.equal(shouldRecord(null, fix(), 30), true)
  const last = fix()
  assert.equal(shouldRecord(last, fix({ t: last.t + 10_000 }), 30), false) // standing still, too soon
  assert.equal(shouldRecord(last, fix({ t: last.t + 30_000 }), 30), true) // heartbeat
  assert.equal(shouldRecord(last, fix({ t: last.t + 10_000, latitude: 18.5304 }), 30), true) // moved ~1.1 km
  assert.equal(shouldRecord(last, fix({ t: last.t + 2_000, latitude: 18.5304 }), 30), false) // moved, but under the minimum gap
  assert.equal(shouldRecord(last, fix({ t: last.t + 60_000, accuracy_m: 5000 }), 30), false) // the server would reject it
  assert.equal(shouldRecord(last, fix({ t: last.t - 5_000 }), 30), false) // clock went backwards
  assert.equal(shouldRecord(null, fix({ accuracy_m: Number.NaN }), 30), false)
})

test('distance and age formatting', () => {
  assert.equal(fmtDistance(450), '450 m')
  assert.equal(fmtDistance(1000), '1.0 km')
  assert.equal(fmtDistance(2449), '2.4 km')
  assert.equal(fmtDistance(15_400), '15 km')
  assert.equal(fmtAge(null), '—')
  assert.equal(fmtAge(3), 'just now')
  assert.equal(fmtAge(45), '45 s ago')
  assert.equal(fmtAge(360), '6 min ago')
  assert.equal(fmtAge(3 * 3600 + 5 * 60), '3 h 5 min ago')
  assert.equal(fmtAge(7200), '2 h ago')
  assert.equal(fmtAccuracy(12.4), '±12 m')
  assert.equal(fmtAccuracy(undefined), '—')
  assert.equal(ageSeconds('2026-01-01T00:00:10Z', Date.parse('2026-01-01T00:01:10Z')), 60)
  assert.equal(ageSeconds('2026-01-01T00:02:00Z', Date.parse('2026-01-01T00:01:00Z')), 0) // never negative
})

test('only the "live" status claims to be live; directions link asks for driving', () => {
  assert.equal(STATUS_META.live.label, 'Live')
  for (const k of ['stale', 'lost', 'no_fix', 'off_duty'] as const) assert.notEqual(STATUS_META[k].label, 'Live')
  const url = directionsUrl(18.5, 73.8)
  assert.ok(url.includes('destination=18.5,73.8') && url.includes('travelmode=driving'))
})

test('a position degrades on its own as time passes without an update', () => {
  const t = { live_s: 120, stale_s: 900 }
  assert.equal(statusAtAge(0, t), 'live')
  assert.equal(statusAtAge(120, t), 'live')
  assert.equal(statusAtAge(121, t), 'stale')
  assert.equal(statusAtAge(900, t), 'stale')
  assert.equal(statusAtAge(901, t), 'lost')
  // reported live (age 100 s) but the screen has not heard from the server for 60 s: no longer live
  assert.equal(statusAtAge(100 + 60, t), 'stale')
})

test('a reading is "fresh" only when recent, tolerating a little clock skew; readings round for the API', async () => {
  const { isFresh, toReading, gpsMessage, GpsError } = await import('./gps.ts')
  const now = 1_700_000_000_000
  assert.equal(isFresh(now - 5_000, now), true)
  assert.equal(isFresh(now - 15_000, now), true)
  assert.equal(isFresh(now - 15_001, now), false)
  assert.equal(isFresh(now - 600_000, now), false) // a cached reading is not "where I am now"
  assert.equal(isFresh(now + 3_000, now), true) // small skew
  assert.equal(isFresh(now + 60_000, now), false) // clearly from the future
  const r = toReading({ latitude: 18.520430123, longitude: 73.8567439876, accuracy: 12.34, timestamp: now })
  assert.deepEqual([r.latitude, r.longitude, r.accuracy_m], [18.52043, 73.856744, 12.3])
  assert.equal(r.captured_at, new Date(now).toISOString())
  assert.match(gpsMessage(new GpsError('denied')), /blocked/)
  assert.match(gpsMessage(new GpsError('stale')), /old location/)
})
