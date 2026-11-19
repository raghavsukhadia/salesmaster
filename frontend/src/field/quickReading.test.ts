/// <reference types="node" />
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { GOOD_FIX_M, GpsError, quickReading } from './gps.ts'

type Watch = { ok: PositionCallback; err: PositionErrorCallback; high: boolean }

/** A scriptable stand-in for navigator.geolocation: tests decide which fixes arrive, and when. */
function fakeGeo() {
  const watches = new Map<number, Watch>()
  const cleared: number[] = []
  let n = 0
  const geo = {
    watchPosition: (ok: PositionCallback, err: PositionErrorCallback, o?: PositionOptions) => { watches.set(++n, { ok, err, high: !!o?.enableHighAccuracy }); return n },
    clearWatch: (id: number) => { watches.delete(id); cleared.push(id) },
  }
  Object.defineProperty(globalThis, 'navigator', { value: { geolocation: geo }, configurable: true, writable: true })
  // Browsers expose coordinates as getters on a prototype; a plain object would hide a `{ ...coords }` mistake.
  class Coords {
    a: number
    constructor(a: number) { this.a = a }
    get latitude() { return 18.5204 }
    get longitude() { return 73.8567 }
    get accuracy() { return this.a }
  }
  const fix = (accuracy: number, ageMs = 0) => ({ coords: new Coords(accuracy), timestamp: Date.now() - ageMs }) as unknown as GeolocationPosition
  return {
    cleared, active: () => watches.size,
    emit: (accuracy: number, ageMs = 0) => [...watches.values()].forEach((w) => w.ok(fix(accuracy, ageMs))),
    emitTo: (high: boolean, accuracy: number) => [...watches.values()].filter((w) => w.high === high).forEach((w) => w.ok(fix(accuracy))),
    fail: (code: number) => [...watches.values()].forEach((w) => w.err({ code, message: '' } as GeolocationPositionError)),
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
afterEach(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator') })

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
const kind = (p: Promise<unknown>) => p.then(() => 'resolved', (e: GpsError) => e.kind)

test('asks for a quick fix and a GPS fix at the same time', () => {
  const g = fakeGeo()
  void quickReading({ hardMs: 20 }).catch(() => {})
  assert.equal(g.active(), 2)
})

test('a good fix is returned at once and everything is switched off', async () => {
  const g = fakeGeo()
  const p = quickReading({ settleMs: 10_000, hardMs: 10_000 }) // would hang for 10 s if it waited
  g.emit(GOOD_FIX_M - 1)
  const r = await p
  assert.equal(r.latitude, 18.5204) // read from the getters, not lost
  assert.equal(r.longitude, 73.8567)
  assert.equal(r.accuracy_m, GOOD_FIX_M - 1)
  assert.equal(g.active(), 0)
})

test('a rough fix waits briefly for a better one, and the better one wins at once', async () => {
  const g = fakeGeo()
  const p = quickReading({ settleMs: 10_000, hardMs: 10_000 })
  g.emitTo(false, 800) // network fix first
  await tick()
  g.emitTo(true, 30) // then GPS
  assert.equal((await p).accuracy_m, 30)
})

test('a rough fix that never improves is returned after the settle time, not the full timeout', async () => {
  const g = fakeGeo()
  const t0 = Date.now()
  const p = quickReading({ settleMs: 30, hardMs: 10_000 })
  g.emit(800)
  const r = await p
  assert.equal(r.accuracy_m, 800)
  assert.ok(Date.now() - t0 < 1_000, 'must not wait for the hard timeout')
  assert.equal(g.active(), 0)
})

test('the best fix seen is the one returned', async () => {
  const g = fakeGeo()
  const p = quickReading({ settleMs: 40, hardMs: 10_000 })
  g.emit(900); g.emit(400); g.emit(600)
  assert.equal((await p).accuracy_m, 400)
})

test('no fix at all fails with "timeout"', async () => {
  fakeGeo()
  assert.equal(await kind(quickReading({ hardMs: 30 })), 'timeout')
})

test('a position older than 15 seconds is never accepted', async () => {
  const g = fakeGeo()
  const p = kind(quickReading({ hardMs: 40 }))
  g.emit(5, 60_000)
  assert.equal(await p, 'stale')
})

test('blocked location fails at once with "denied", but a fix already in hand is kept', async () => {
  const g1 = fakeGeo()
  const p1 = kind(quickReading({ hardMs: 10_000 }))
  g1.fail(1)
  assert.equal(await p1, 'denied')

  const g2 = fakeGeo()
  const p2 = quickReading({ settleMs: 10_000, hardMs: 10_000 })
  g2.emit(500)
  g2.fail(1)
  assert.equal((await p2).accuracy_m, 500)
})

test('when both requests fail the reason is reported, and one failing alone is not the end', async () => {
  const g = fakeGeo()
  const p = kind(quickReading({ hardMs: 10_000 }))
  g.fail(2) // both report "position unavailable"
  assert.equal(await p, 'unavailable')

  const g2 = fakeGeo()
  const p2 = quickReading({ hardMs: 10_000 })
  g2.emitTo(true, 25) // a good fix still arrives
  assert.equal((await p2).accuracy_m, 25)
  assert.equal(g2.active(), 0)
})

test('a browser without geolocation fails with "unsupported"', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
  assert.equal(await kind(quickReading()), 'unsupported')
})

test('a fresh, good tracker fix is returned at once without asking the GPS', async () => {
  const g = fakeGeo()
  const r = await quickReading({ hardMs: 10_000, latest: { latitude: 21.1458, longitude: 79.0882, accuracy_m: 20, t: Date.now() - 2_000 } })
  assert.equal(r.latitude, 21.1458)
  assert.equal(g.active(), 0)
})

test('a rough tracker fix is used after the settle time if the GPS has nothing better', async () => {
  const g = fakeGeo()
  const r = await quickReading({ settleMs: 30, hardMs: 10_000, latest: { latitude: 21.1, longitude: 79.0, accuracy_m: 900, t: Date.now() } })
  assert.equal(r.accuracy_m, 900)
  assert.equal(g.active(), 0)
})

test('an old tracker fix is ignored', async () => {
  fakeGeo()
  assert.equal(await kind(quickReading({ hardMs: 30, latest: { latitude: 21.1, longitude: 79.0, accuracy_m: 10, t: Date.now() - 60_000 } })), 'timeout')
})
