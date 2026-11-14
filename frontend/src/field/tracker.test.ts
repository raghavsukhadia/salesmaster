/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FieldTracker, type DutyResponse, type GeoErr, type GeoPos, type TrackerDeps } from './fieldTracker.ts'
import type { KeyValueStore } from './queue.ts'

class Store implements KeyValueStore {
  data = new Map<string, string>()
  getItem = (k: string) => this.data.get(k) ?? null
  setItem = (k: string, v: string) => { this.data.set(k, v) }
  removeItem = (k: string) => { this.data.delete(k) }
}

const duty = (on: boolean): DutyResponse => ({
  on_duty: on, server_time: new Date(0).toISOString(), session: on ? { id: 1, started_at: '', ping_count: 0, last_contact_at: null, last_fix: null } : null,
  tracking: { status: on ? 'no_fix' : 'off_duty', is_live: false, age_s: null },
  policy: { consent_version: 'v1', ping_interval_s: 30, retention_days: 90, notice: [] },
})

class HttpError extends Error {
  status: number | null
  constructor(status: number | null) { super(`http ${status}`); this.status = status }
}

interface Call { path: string; method: string; body?: any }

function rig(opts: { onDuty?: boolean } = {}) {
  let onDuty = opts.onDuty ?? false
  let online = true
  let clock = 1_700_000_000_000
  let ids = 0
  let watcher: { ok: (p: GeoPos) => void; err: (e: GeoErr) => void } | null = null
  let lastHandler: { ok: (p: GeoPos) => void } | null = null // kept after clearWatch, to simulate a straggler callback
  let watches = 0, clears = 0
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = []
  const calls: Call[] = []
  const behaviour = {
    upload: [] as (null | number)[], /* queued failures: status code, or null = network error */
    endFails: 0,
    serverStatus: 'live' as string, // what the server says about the salesman after an upload
    reject: [] as string[], // reasons the server gives for rejecting points while still answering 200
  }
  const uploaded: any[] = []
  const sampleRequests: ((p: GeoPos) => void)[] = [] // getCurrentPosition calls the tracker made, awaiting an answer
  const store = new Store()

  const deps: TrackerDeps = {
    async api<T>(path: string, init: { method?: string; body?: any } = {}) {
      const method = init.method ?? 'GET'
      calls.push({ path, method, body: init.body })
      if (!online) throw new HttpError(null)
      if (path === '/api/field/session/') return { ...duty(onDuty), tracking: { status: onDuty ? behaviour.serverStatus : 'off_duty', is_live: onDuty && behaviour.serverStatus === 'live', age_s: null } } as T
      if (path === '/api/field/session/start/') { onDuty = true; return duty(true) as T }
      if (path === '/api/field/session/end/') {
        if (behaviour.endFails > 0) { behaviour.endFails--; throw new HttpError(null) }
        onDuty = false; return duty(false) as T
      }
      if (path === '/api/field/locations/') {
        if (behaviour.upload.length) { const f = behaviour.upload.shift()!; throw new HttpError(f) }
        if (behaviour.reject.length) return { accepted: 0, duplicates: 0, rejected: init.body.points.map((p: any) => ({ client_point_id: p.client_point_id, reason: behaviour.reject[0] })), on_duty: onDuty, tracking: { status: behaviour.serverStatus } } as T
        uploaded.push(...init.body.points)
        return { accepted: init.body.points.length, duplicates: 0, rejected: [], on_duty: onDuty, tracking: { status: behaviour.serverStatus } } as T
      }
      throw new Error('unexpected ' + path)
    },
    geo: {
      watchPosition(ok, err) { watches++; watcher = { ok, err }; lastHandler = watcher; return watches },
      getCurrentPosition(ok) { sampleRequests.push(ok) },
      clearWatch() { clears++; watcher = null },
    },
    store,
    now: () => clock,
    setTimer(fn, ms) { const t = { fn, ms, id: timers.length, live: true }; timers.push(t); return t.id },
    clearTimer(h) { if (typeof h === 'number' && timers[h]) timers[h].live = false },
    isOnline: () => online,
    uuid: () => `pt-${++ids}`,
  }
  const tracker = new FieldTracker(deps)
  const fix = (n: number, extra: Partial<GeoPos['coords']> = {}): GeoPos => ({
    coords: { latitude: 18.5 + n * 0.001, longitude: 73.8, accuracy: 12, ...extra }, timestamp: clock + n * 31_000,
  })
  return {
    tracker, calls, uploaded, store, timers, behaviour,
    setOnline: (v: boolean) => { online = v; tracker.setOnline(v) },
    // connectivity changes without the browser's 'online' event having reached the tracker yet
    flipSilently: (v: boolean) => { online = v },
    emit: (p: GeoPos) => { clock = p.timestamp; watcher!.ok(p) },
    emitError: (code: number) => watcher!.err({ code }),
    emitLate: (p: GeoPos) => { clock = p.timestamp; lastHandler!.ok(p) },
    emitRaw: (p: GeoPos) => lastHandler!.ok(p), // delivers the reading without touching the clock
    sampleRequests,
    advance: (ms: number) => { clock += ms },
    runTimers: async (minMs = 0, maxMs = Infinity) => { for (const t of timers.filter((x) => x.live && x.ms >= minMs && x.ms <= maxMs)) { t.live = false; t.fn() } await tick() },
    fix, watching: () => watcher !== null, watchCount: () => watches, clearCount: () => clears,
    flushTimers: async () => { for (const t of timers.filter((x) => x.live && x.ms < 60_000)) { t.live = false; t.fn() } await tick() },
    tick,
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const posts = (calls: Call[], path: string) => calls.filter((c) => c.path === path && c.method === 'POST')

test('nothing is watched or recorded while off duty', async () => {
  const r = rig({ onDuty: false })
  await r.tracker.init(7)
  assert.equal(r.watching(), false)
  assert.equal(r.tracker.getState().duty?.on_duty, false)
  assert.equal(posts(r.calls, '/api/field/locations/').length, 0)
})

test('going on duty starts GPS; fixes are queued and uploaded with the device send time', async () => {
  const r = rig()
  await r.tracker.init(7)
  await r.tracker.start()
  assert.equal(r.watching(), true)
  assert.deepEqual(posts(r.calls, '/api/field/session/start/')[0].body, { consent: true, consent_version: 'v1' })
  r.emit(r.fix(1))
  await r.tick()
  assert.equal(r.uploaded.length, 1)
  const body = posts(r.calls, '/api/field/locations/')[0].body
  assert.ok(body.sent_at && body.points[0].captured_at.endsWith('Z'))
  assert.equal(r.tracker.getState().queued, 0)
  assert.equal(r.tracker.getState().gps, 'ok')
  assert.ok(r.tracker.getState().lastUploadAt)
})

test('offline: points pile up locally, then all sync when the connection returns, oldest first, no duplicates', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.setOnline(false)
  for (let i = 1; i <= 5; i++) r.emit(r.fix(i))
  await r.tick()
  assert.equal(r.tracker.getState().queued, 5)
  assert.equal(r.tracker.getState().uploadProblem, 'offline')
  assert.equal(r.uploaded.length, 0)
  assert.equal(JSON.parse(r.store.getItem('sm_field_queue:7')!).length, 5) // survives a reload

  r.setOnline(true)
  await r.tick(); await r.tick()
  assert.deepEqual(r.uploaded.map((p) => p.client_point_id), ['pt-1', 'pt-2', 'pt-3', 'pt-4', 'pt-5'])
  assert.equal(r.tracker.getState().queued, 0)
  assert.equal(r.tracker.getState().uploadProblem, null)
  assert.equal(r.store.getItem('sm_field_queue:7'), null)
})

test('a reload picks the persisted queue up and uploads it', async () => {
  const r = rig({ onDuty: true })
  r.store.setItem('sm_field_queue:7', JSON.stringify([
    { client_point_id: 'old-1', latitude: 18.5, longitude: 73.8, accuracy_m: 9, captured_at: '2026-01-01T00:00:00.000Z' },
  ]))
  await r.tracker.init(7)
  await r.tick(); await r.tick()
  assert.deepEqual(r.uploaded.map((p) => p.client_point_id), ['old-1'])
})

test('server errors keep the queue and retry with backoff; a malformed batch is discarded, not looped', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.behaviour.upload.push(500)
  r.emit(r.fix(1))
  await r.tick()
  assert.equal(r.tracker.getState().queued, 1)
  assert.equal(r.tracker.getState().uploadProblem, 'server')
  await r.flushTimers() // the scheduled retry
  await r.tick()
  assert.equal(r.tracker.getState().queued, 0)

  r.behaviour.upload.push(400, 400, 400) // a server that rejects this batch every time
  const before = posts(r.calls, '/api/field/locations/').length
  r.emit(r.fix(2))
  await r.tick()
  assert.equal(r.tracker.getState().queued, 0)
  assert.equal(r.tracker.getState().discarded, 1)
  assert.equal(posts(r.calls, '/api/field/locations/').length - before, 1, 'a malformed batch is sent once, not retried')
  assert.equal(r.uploaded.length, 1) // only the earlier good point ever arrived
})

test('401/403 stop uploading but keep the points for the next login', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.behaviour.upload.push(401)
  r.emit(r.fix(1))
  await r.tick()
  assert.equal(r.tracker.getState().uploadProblem, 'auth')
  assert.equal(r.tracker.getState().queued, 1)
})

test('GPS permission problems are surfaced, not hidden', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.emitError(1)
  assert.equal(r.tracker.getState().gps, 'denied')
  r.emitError(2)
  assert.equal(r.tracker.getState().gps, 'unavailable')
  r.emitError(3)
  assert.equal(r.tracker.getState().gps, 'timeout')
})

test('ending duty stops recording at once, uploads the backlog first, then closes the session', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.setOnline(false)
  r.emit(r.fix(1))
  r.emit(r.fix(2))
  await r.tick()
  assert.equal(r.tracker.getState().queued, 2)
  r.flipSilently(true) // the connection is back, but nothing has told the tracker to flush: only End can
  const done = r.tracker.end()
  assert.equal(r.watching(), false) // recording stopped synchronously with the button press
  await done
  const order = r.calls.filter((c) => c.method === 'POST').map((c) => c.path)
  assert.ok(order.includes('/api/field/locations/'), 'End must upload the backlog itself: ' + order.join(' > '))
  assert.ok(order.lastIndexOf('/api/field/locations/') < order.indexOf('/api/field/session/end/'), order.join(' > '))
  assert.equal(r.uploaded.length, 2)
  const s = r.tracker.getState()
  assert.equal(s.duty?.on_duty, false)
  assert.equal(s.pendingEnd, false)
  assert.equal(r.store.getItem('sm_field_pending_end:7'), null)
})

test('ending duty while offline stops recording immediately and finishes when back online', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.emit(r.fix(1))
  await r.tick()
  r.setOnline(false)
  await r.tracker.end()
  assert.equal(r.watching(), false)
  assert.equal(r.tracker.getState().pendingEnd, true)
  assert.equal(r.store.getItem('sm_field_pending_end:7'), '1')
  r.setOnline(true)
  await r.tick(); await r.tick(); await r.tick()
  assert.equal(r.tracker.getState().pendingEnd, false)
  assert.equal(r.tracker.getState().duty?.on_duty, false)
})

test('a pending end survives a reload and is completed on the next init', async () => {
  const r = rig({ onDuty: true })
  r.store.setItem('sm_field_pending_end:7', '1')
  await r.tracker.init(7)
  assert.equal(r.tracker.getState().duty?.on_duty, false)
  assert.equal(r.watching(), false)
  assert.equal(r.watchCount(), 0) // never resumed recording for a salesman who had already pressed End
})

test('a straggler fix delivered by the browser after End is not recorded', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.setOnline(false)
  r.emit(r.fix(1))
  await r.tick()
  await r.tracker.end() // offline: recording stops, the server call is pending
  assert.equal(r.tracker.getState().queued, 1)
  r.emitLate(r.fix(2)) // the browser still had a callback in flight
  await r.tick()
  assert.equal(r.tracker.getState().queued, 1, 'the late fix must be dropped')
  assert.equal(r.tracker.getState().position?.latitude, r.fix(1).coords.latitude)
})

test('sign-out stops recording but keeps the unsent points', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.setOnline(false)
  r.emit(r.fix(1))
  await r.tick()
  r.tracker.shutdown()
  assert.equal(r.watching(), false)
  assert.equal(JSON.parse(r.store.getItem('sm_field_queue:7')!).length, 1)
  assert.equal(r.tracker.getState().duty, null)
})

test('standing still does not flood the server; the heartbeat interval still records', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  const still = (secs: number): GeoPos => ({ coords: { latitude: 18.5, longitude: 73.8, accuracy: 10 }, timestamp: 1_700_000_000_000 + secs * 1000 })
  for (const s of [0, 3, 6, 9, 12]) r.emit(still(s))
  await r.tick()
  assert.equal(r.uploaded.length, 1)
  r.emit(still(31))
  await r.tick()
  assert.equal(r.uploaded.length, 2)
})

test('a device with no geolocation API says so', async () => {
  const t = new FieldTracker({ api: async () => duty(true) as never, geo: null, store: new Store(), now: Date.now,
    setTimer: () => 0, clearTimer: () => {}, isOnline: () => true, uuid: () => 'x' })
  await t.init(1)
  assert.equal(t.getState().gps, 'unsupported')
})


test('a stationary phone is sampled actively, because watchPosition goes quiet when nothing moves', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.emit(r.fix(1)) // one callback, then the browser reports nothing more
  await r.tick()
  assert.equal(r.uploaded.length, 1)
  assert.equal(r.sampleRequests.length, 0)
  r.advance(31_000) // a full interval of silence
  await r.runTimers(30_000, 30_000) // the sampler fires
  assert.equal(r.sampleRequests.length, 1, 'the tracker must ask for a fresh reading itself')
  r.sampleRequests[0](r.fix(1.5, {}) as GeoPos) // the browser answers with a fresh reading
  await r.tick()
  assert.equal(r.uploaded.length, 2)
})

test('no active sampling while the watch is delivering, and none after End', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.emit(r.fix(1))
  r.advance(20_000)
  r.emit({ coords: { latitude: 18.6, longitude: 73.9, accuracy: 10 }, timestamp: 1_700_000_000_000 + 31_000 + 20_000 })
  await r.runTimers(30_000, 30_000)
  assert.equal(r.sampleRequests.length, 0, 'the watch delivered recently, so no extra request is needed')
  r.setOnline(false)
  await r.tracker.end()
  r.advance(60_000)
  await r.runTimers(30_000, 30_000)
  assert.equal(r.sampleRequests.length, 0, 'sampling stops with duty')
})

test('a cached reading is never recorded as if it were current', async () => {
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  const stale: GeoPos = { coords: { latitude: 18.5, longitude: 73.8, accuracy: 10 }, timestamp: 1_700_000_000_000 - 60_000 }
  r.advance(60_000)
  r.emitRaw(stale) // delivered "now", but taken a minute ago
  await r.tick()
  assert.equal(r.uploaded.length, 0)
  assert.equal(r.tracker.getState().queued, 0)
  assert.equal(r.tracker.getState().position, null, 'an old reading must not be shown as the current position either')
  assert.equal(r.tracker.getState().gps, 'waiting')
})

test('the status never claims "shared" on the phone\'s optimism: the server\'s verdict decides', async () => {
  const { trackingSummary } = await import('./summary.ts')
  const r = rig({ onDuty: true })
  r.behaviour.serverStatus = 'no_fix'
  r.behaviour.reject = ['outside_session']
  await r.tracker.init(7)
  r.emit(r.fix(1))
  await r.tick()
  const s = r.tracker.getState()
  assert.equal(s.uploadProblem, null) // the upload itself succeeded (200)...
  assert.equal(s.serverStatus, 'no_fix') // ...but the server has no position for this salesman
  const sum = trackingSummary(s)
  assert.notEqual(sum.tone, 'green')
  assert.match(sum.text, /not accepting your position/)
  assert.match(sum.text, /clock/)

  // once the server confirms a live position, it turns green
  r.behaviour.reject = []
  r.behaviour.serverStatus = 'live'
  r.emit(r.fix(2))
  await r.tick()
  const ok = trackingSummary(r.tracker.getState())
  assert.equal(ok.tone, 'green')
  assert.match(ok.text, /being shared/)
})

test('a quiet heartbeat refresh updates what the server says (stale/lost) even without uploads', async () => {
  const { trackingSummary } = await import('./summary.ts')
  const r = rig({ onDuty: true })
  await r.tracker.init(7)
  r.emit(r.fix(1))
  await r.tick()
  assert.equal(trackingSummary(r.tracker.getState()).tone, 'green')
  // the server now reports the position as stale (e.g. the phone stopped delivering)
  r.behaviour.serverStatus = 'stale'
  await r.tracker.refresh()
  assert.equal(r.tracker.getState().serverStatus, 'stale')
  const sum = trackingSummary(r.tracker.getState())
  assert.notEqual(sum.tone, 'green')
  assert.match(sum.text, /out of date/)
})

test('trackingSummary: green only when the server confirms a live position', async () => {
  const { trackingSummary } = await import('./summary.ts')
  const base = {
    loaded: true, error: null, duty: duty(true), gps: 'ok', position: null, queued: 0, discarded: 0, online: true,
    lastUploadAt: 1, uploadProblem: null, pendingEnd: false, busy: false, serverStatus: 'live', lastRejected: [],
  } as unknown as Parameters<typeof trackingSummary>[0]
  const text = (patch: object) => trackingSummary({ ...base, ...patch } as typeof base)
  assert.equal(text({}).tone, 'green')
  const none = text({ serverStatus: 'no_fix' })
  assert.equal(none.tone, 'amber')
  assert.match(none.text, /Waiting for the server to confirm/)
  assert.equal(text({ serverStatus: null }).tone, 'amber')
  assert.match(text({ serverStatus: 'stale' }).text, /out of date/)
  assert.match(text({ serverStatus: 'lost' }).text, /out of date/)
  assert.equal(text({ duty: duty(false), serverStatus: null }).tone, 'gray')
  assert.equal(text({ gps: 'denied' }).tone, 'red')
  assert.equal(text({ pendingEnd: true }).tone, 'amber')
  assert.match(text({ online: false, queued: 3 }).text, /Offline: 3 points saved on this phone/)
})
