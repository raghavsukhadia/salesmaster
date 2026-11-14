// The duty tracker: one long-lived object (not a React hook) so recording survives moving between pages.
// All I/O is injected, so the behaviour that matters (offline queue, end-duty ordering, stop conditions)
// is unit-tested with fakes in tracker.test.ts.
import {
  backoffSeconds, enqueue, loadQueue, nextBatch, removeSent, saveQueue, shouldRecord,
  type Fix, type KeyValueStore, type QueuedPoint,
} from './queue.ts'
import type { TrackStatus } from './format.ts'

export interface DutyResponse {
  on_duty: boolean
  server_time: string
  session: null | {
    id: number; started_at: string; ping_count: number; last_contact_at: string | null
    last_fix: null | { latitude: number; longitude: number; accuracy_m: number; quality: string; captured_at: string }
  }
  tracking: { status: TrackStatus; is_live: boolean; age_s: number | null }
  policy: { consent_version: string; ping_interval_s: number; retention_days: number; notice: string[] }
}

interface UploadResponse { accepted: number; duplicates: number; rejected: { client_point_id: string; reason: string }[]; on_duty: boolean; tracking: { status: TrackStatus } }

export interface GeoPos { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }
export interface GeoErr { code: number; message?: string }

export interface TrackerDeps {
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>
  geo: {
    watchPosition(ok: (p: GeoPos) => void, err: (e: GeoErr) => void, opts: Record<string, unknown>): number
    getCurrentPosition(ok: (p: GeoPos) => void, err: (e: GeoErr) => void, opts: Record<string, unknown>): void
    clearWatch(id: number): void
  } | null
  store: KeyValueStore
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  isOnline(): boolean
  uuid(): string
}

export type GpsState = 'idle' | 'waiting' | 'ok' | 'denied' | 'unavailable' | 'timeout' | 'unsupported'
export type UploadProblem = null | 'offline' | 'server' | 'auth'

export interface TrackerState {
  loaded: boolean
  error: string | null
  duty: DutyResponse | null
  gps: GpsState
  position: Fix | null
  queued: number
  discarded: number // points thrown away because the server called the batch malformed
  online: boolean
  lastUploadAt: number | null
  uploadProblem: UploadProblem
  pendingEnd: boolean // the salesman pressed End duty; recording has stopped, the server call is still to land
  busy: boolean
  // The server's own verdict on this salesman's position. The screen must never claim "shared" on the
  // phone's optimism alone: fixes can be rejected (wrong clock, poor accuracy) while uploads still return 200.
  serverStatus: TrackStatus | null
  lastRejected: string[] // reasons the server gave for the points in the most recent upload
}

const HEARTBEAT_MS = 60_000
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }
const SAMPLE_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 }
/** A reading older than this is a cached position, not where the phone is now: it is never recorded. */
export const MAX_FIX_AGE_MS = 20_000
const statusOf = (e: unknown): number | null => (e && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null)

export class FieldTracker {
  private state: TrackerState
  private listeners = new Set<() => void>()
  private userId: number | null = null
  private queue: QueuedPoint[] = []
  private watchId: number | null = null
  private last: Fix | null = null
  private flushing = false
  private flushAgain = false
  private failures = 0
  private retry: unknown = null
  private heartbeat: unknown = null
  private sampler: unknown = null
  private lastCallbackAt = 0

  private d: TrackerDeps

  constructor(deps: TrackerDeps) {
    const d = deps
    this.d = d
    this.state = {
      loaded: false, error: null, duty: null, gps: d.geo ? 'idle' : 'unsupported', position: null, queued: 0,
      discarded: 0, online: d.isOnline(), lastUploadAt: null, uploadProblem: null, pendingEnd: false, busy: false,
      serverStatus: null, lastRejected: [],
    }
  }

  // ---- store plumbing ----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getState = () => this.state
  private set(patch: Partial<TrackerState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((l) => l()) }
  private qKey = () => `sm_field_queue:${this.userId}`
  private endKey = () => `sm_field_pending_end:${this.userId}`
  private persist() { saveQueue(this.d.store, this.qKey(), this.queue); this.set({ queued: this.queue.length }) }

  // ---- lifecycle ----
  /** Safe to call from every page: the first call for a user loads state, later calls just refresh. */
  async init(userId: number) {
    if (this.userId !== userId) {
      this.shutdown()
      this.userId = userId
      this.queue = loadQueue(this.d.store, this.qKey())
      let pending = false
      try { pending = this.d.store.getItem(this.endKey()) === '1' } catch { /* storage unavailable */ }
      this.set({ queued: this.queue.length, pendingEnd: pending, loaded: false, error: null })
    }
    await this.refresh()
    if (this.state.pendingEnd) await this.tryEnd()
  }

  /** Stop recording and timers (sign-out, unmount of the whole app). The persisted queue is kept. */
  shutdown() {
    this.stopWatch()
    this.d.clearTimer(this.retry); this.d.clearTimer(this.heartbeat); this.d.clearTimer(this.sampler)
    this.retry = this.heartbeat = this.sampler = null
    this.userId = null
    this.last = null
    this.set({ duty: null, loaded: false, gps: this.d.geo ? 'idle' : 'unsupported', position: null, busy: false })
  }

  setOnline(online: boolean) {
    this.set({ online })
    if (online && this.userId !== null) {
      this.failures = 0
      void this.flush()
      if (this.state.pendingEnd) void this.tryEnd()
    }
  }

  async refresh() {
    if (this.userId === null) return
    try {
      const duty = await this.d.api<DutyResponse>('/api/field/session/')
      this.set({ duty, loaded: true, error: null, serverStatus: duty.on_duty ? duty.tracking.status : null })
    } catch (e) {
      this.set({ loaded: true, error: statusOf(e) === 403 ? 'This account has no active salesman profile.' : 'Could not reach the server.' })
    }
    this.syncWatch()
    this.scheduleHeartbeat()
    if (this.queue.length) void this.flush()
  }

  // ---- duty ----
  async start() {
    const duty = this.state.duty
    if (!duty || this.state.busy || this.state.pendingEnd) return
    this.set({ busy: true, error: null })
    try {
      const next = await this.d.api<DutyResponse>('/api/field/session/start/', {
        method: 'POST', body: { consent: true, consent_version: duty.policy.consent_version },
      })
      this.last = null
      this.set({ duty: next, busy: false, gps: this.d.geo ? 'waiting' : 'unsupported' })
      this.syncWatch()
      this.scheduleHeartbeat()
    } catch (e) {
      this.set({ busy: false, error: statusOf(e) === 400 ? 'The tracking notice changed. Please read and accept it again.' : 'Could not start duty. Check your connection and try again.' })
      await this.refresh()
    }
  }

  /** Recording stops immediately; the server is told as soon as the connection allows. */
  async end() {
    if (!this.state.duty?.on_duty || this.state.pendingEnd) return
    try { this.d.store.setItem(this.endKey(), '1') } catch { /* the in-memory flag still holds for this session */ }
    this.set({ pendingEnd: true })
    this.syncWatch()
    await this.tryEnd()
  }

  private async tryEnd() {
    if (this.userId === null) return
    this.set({ busy: true })
    await this.flush() // anything captured before the button press is uploaded while the session is still open
    try {
      const duty = await this.d.api<DutyResponse>('/api/field/session/end/', { method: 'POST' })
      try { this.d.store.removeItem(this.endKey()) } catch { /* ignore */ }
      this.set({ duty, pendingEnd: false, busy: false, gps: 'idle', position: null, error: null, serverStatus: null, lastRejected: [] })
      this.syncWatch()
      if (this.queue.length) void this.flush() // late stragglers still sync inside the server's grace window
    } catch {
      this.failures++
      this.set({ busy: false })
      this.scheduleRetry(() => this.tryEnd())
    }
  }

  // ---- GPS ----
  private shouldWatch = () => !!this.state.duty?.on_duty && !this.state.pendingEnd && !!this.d.geo

  private syncWatch() {
    if (this.shouldWatch() && this.watchId === null) {
      this.set({ gps: this.state.gps === 'ok' ? 'ok' : 'waiting' })
      this.lastCallbackAt = this.d.now()
      this.watchId = this.d.geo!.watchPosition(this.onPosition, this.onGeoError, WATCH_OPTIONS)
      this.scheduleSampler()
    } else if (!this.shouldWatch() && this.watchId !== null) {
      this.stopWatch()
      this.set({ gps: this.d.geo ? 'idle' : 'unsupported' })
    }
  }

  private stopWatch() {
    if (this.watchId !== null) this.d.geo?.clearWatch(this.watchId)
    this.watchId = null
    this.d.clearTimer(this.sampler)
    this.sampler = null
  }

  // watchPosition only reports when the position *changes*: a phone standing still at a dealer's counter can
  // go silent. So once per interval, if the watch has been quiet, ask for a fresh reading explicitly.
  private scheduleSampler() {
    this.d.clearTimer(this.sampler)
    this.sampler = null
    if (!this.shouldWatch()) return
    const ms = (this.state.duty?.policy.ping_interval_s ?? 30) * 1000
    this.sampler = this.d.setTimer(() => {
      this.sampler = null
      if (!this.shouldWatch()) return
      if (this.d.now() - this.lastCallbackAt >= ms - 1000) this.d.geo!.getCurrentPosition(this.onPosition, this.onGeoError, SAMPLE_OPTIONS)
      this.scheduleSampler()
    }, ms)
  }

  private onPosition = (p: GeoPos) => {
    if (!this.shouldWatch()) return
    this.lastCallbackAt = this.d.now()
    // A cached reading (old timestamp) is not where the phone is now. Recording it would present an old
    // position as current, or put a point before duty began. Wait for a fresh one.
    if (this.d.now() - p.timestamp > MAX_FIX_AGE_MS) { if (this.state.gps !== 'ok') this.set({ gps: 'waiting' }); return }
    const fix: Fix = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy_m: p.coords.accuracy, t: p.timestamp }
    this.set({ gps: 'ok', position: fix })
    const interval = this.state.duty?.policy.ping_interval_s ?? 30
    if (!shouldRecord(this.last, fix, interval)) return
    this.last = fix
    const point: QueuedPoint = {
      client_point_id: this.d.uuid(),
      latitude: Math.round(fix.latitude * 1e6) / 1e6,
      longitude: Math.round(fix.longitude * 1e6) / 1e6,
      accuracy_m: Math.round(fix.accuracy_m * 10) / 10,
      captured_at: new Date(fix.t).toISOString(),
    }
    this.queue = enqueue(this.queue, point).queue
    this.persist()
    void this.flush()
  }

  private onGeoError = (e: GeoErr) => {
    this.set({ gps: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' })
  }

  // ---- upload ----
  async flush() {
    if (this.userId === null) return
    if (this.flushing) { this.flushAgain = true; return }
    if (!this.d.isOnline()) { this.set({ online: false, uploadProblem: this.queue.length ? 'offline' : null }); return }
    this.flushing = true
    try {
      do {
        this.flushAgain = false
        while (this.queue.length && this.userId !== null) {
          const batch = nextBatch(this.queue)
          let res: UploadResponse
          try {
            res = await this.d.api<UploadResponse>('/api/field/locations/', {
              method: 'POST', body: { sent_at: new Date(this.d.now()).toISOString(), points: batch },
            })
          } catch (e) {
            const status = statusOf(e)
            if (status === 400) { // the batch itself is malformed and can never succeed: discard, don't loop
              this.queue = removeSent(this.queue, batch)
              this.persist()
              this.set({ discarded: this.state.discarded + batch.length })
              continue
            }
            if (status === 401 || status === 403) { this.set({ uploadProblem: 'auth' }); return }
            this.failures++
            this.set({ uploadProblem: status === null ? 'offline' : 'server' })
            this.scheduleRetry(() => this.flush())
            return
          }
          this.failures = 0
          this.queue = removeSent(this.queue, batch) // 200 = every point in the batch has been judged
          this.persist()
          this.set({ lastUploadAt: this.d.now(), uploadProblem: null, serverStatus: res.on_duty ? res.tracking.status : null, lastRejected: res.rejected.map((r) => r.reason) })
          if (!res.on_duty && this.state.duty?.on_duty && !this.state.pendingEnd) void this.refresh() // ended elsewhere
        }
      } while (this.flushAgain)
    } finally {
      this.flushing = false
    }
  }

  private scheduleRetry(fn: () => unknown) {
    this.d.clearTimer(this.retry)
    this.retry = this.d.setTimer(() => { this.retry = null; void fn() }, backoffSeconds(Math.max(1, this.failures)) * 1000)
  }

  private scheduleHeartbeat() {
    this.d.clearTimer(this.heartbeat)
    this.heartbeat = null
    if (this.state.duty?.on_duty && this.userId !== null) {
      this.heartbeat = this.d.setTimer(() => { void this.refresh() }, HEARTBEAT_MS)
    }
  }
}
