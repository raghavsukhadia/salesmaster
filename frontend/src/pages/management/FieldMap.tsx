import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { MapPin, UserRound } from 'lucide-react'
import { api } from '../../auth'
import type { Me } from '../../auth'
import LeafletMap, { type MapMarker } from '../../components/LeafletMap'
import { Badge, Button, buttonClass, fmtTime, PageHeader, Pills, useConfirm } from '../../components/ui'
import { directionsUrl, fmtAccuracy, fmtAge, fmtDistance, STATUS_META, statusAtAge, type TrackStatus } from '../../field/format'

const RADII = ['1', '3', '5', '10', '20'] as const
type Radius = (typeof RADII)[number]
const POLL_MS = 15_000

interface LiveFix { latitude: number; longitude: number; accuracy_m: number; quality: string; captured_at: string }
interface LiveSalesman {
  id: number; name: string; phone: string; on_duty: boolean; status: TrackStatus; is_live: boolean; age_s: number | null
  session_started_at: string | null; last_contact_at: string | null; last_duty_ended_at: string | null; last_fix: LiveFix | null
  last_seen_s: number | null // age of last_fix; off duty this is the last known position from the latest session
}
interface Live { generated_at: string; thresholds: { live_s: number; stale_s: number }; counts: Record<TrackStatus, number>; salesmen: LiveSalesman[] }
interface DealerPin {
  id: number; name: string; shop_name: string; phone: string; city: string; state: string; latitude: number; longitude: number
  address?: string; location_verified: boolean
}
interface DealerMap { total: number; located: number; missing_location: number; results: DealerPin[] }
interface NearDealer extends DealerPin {
  straight_line_m: number; driving_m: number | null; status: string; owner: { id: number; name: string } | null; last_visit_at: string | null
}
interface Nearby {
  origin: { latitude: number; longitude: number; salesman_id?: number; status?: TrackStatus; captured_at?: string }
  radius_km: number; distance_note: string; total: number; truncated: boolean; results: NearDealer[]
}
interface NearSalesman {
  salesman_id: number; name: string; phone: string; is_owner: boolean; status: TrackStatus; is_live: boolean; age_s: number | null
  straight_line_m: number; driving_m: number | null; accuracy_m: number
}
interface Nearest { dealer: { id: number; name: string; latitude: number; longitude: number; location_verified: boolean }; distance_note: string; results: NearSalesman[] }
interface Track { total_points: number; downsampled: boolean; points: { latitude: number; longitude: number; captured_at: string }[]; sessions: { id: number; started_at: string; ended_at: string | null }[] }

type Selection = { kind: 'salesman'; id: number } | { kind: 'dealer'; id: number } | null
type Origin = { kind: 'salesman'; id: number } | { kind: 'point'; lat: number; lng: number } | null

function StatusBadge({ status }: { status: TrackStatus }) {
  const m = STATUS_META[status]
  const cls = { green: 'border-green-200 bg-green-50 text-green-800', amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-800', gray: 'border-slate-200 bg-slate-100 text-slate-600' }[m.tone]
  return <span title={m.hint} className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{m.label}</span>
}

export default function FieldMap({ mode = 'tracking' }: { mode?: 'tracking' | 'nearby' }) {
  const { me } = useOutletContext<{ me: Me }>()
  const confirm = useConfirm()
  const [live, setLive] = useState<Live | null>(null)
  const [dealerMap, setDealerMap] = useState<DealerMap | null>(null)
  const [dealerError, setDealerError] = useState(false)
  const [polledAt, setPolledAt] = useState(0)
  const [pollError, setPollError] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [sel, setSel] = useState<Selection>(null)
  const [origin, setOrigin] = useState<Origin>(null)
  const [radius, setRadius] = useState<Radius>('5')
  const [nearby, setNearby] = useState<Nearby | null>(null)
  const [nearest, setNearest] = useState<Nearest | null>(null)
  const [includeStale, setIncludeStale] = useState(false)
  const [track, setTrack] = useState<Track | null>(null)
  const [pick, setPick] = useState(mode === 'nearby')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [fitKey, setFitKey] = useState('init')

  const poll = useCallback(async () => {
    try {
      const data = await api<Live>('/api/management/field/live/')
      setLive(data); setPolledAt(Date.now()); setPollError(false)
    } catch { setPollError(true) }
  }, [])

  const pollDealers = useCallback(async () => {
    if (mode !== 'tracking') return
    try {
      setDealerMap(await api<DealerMap>('/api/management/field/dealer-markers/'))
      setDealerError(false)
    } catch { setDealerError(true) }
  }, [mode])

  useEffect(() => {
    if (mode !== 'tracking') return
    void pollDealers()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void pollDealers() }, 60_000)
    return () => clearInterval(timer)
  }, [mode, pollDealers])

  useEffect(() => {
    void poll()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void poll() }, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 10_000)
    return () => { clearInterval(t); clearInterval(tick) }
  }, [poll])

  useEffect(() => { if (live && fitKey === 'init') setFitKey('first') }, [live, fitKey])

  // Each row's status as it deserves to be shown *now* (degrades if updates stop arriving).
  const elapsed = polledAt ? Math.max(0, (now - polledAt) / 1000) : 0
  const rows = useMemo(() => (live?.salesmen ?? []).map((s) => {
    if (!s.on_duty || s.age_s === null || !live) return { ...s, shownStatus: s.status, shownAge: s.last_seen_s === null ? null : s.last_seen_s + elapsed }
    const age = s.age_s + elapsed
    return { ...s, shownStatus: statusAtAge(age, live.thresholds) as TrackStatus, shownAge: age }
  }), [live, elapsed])
  const selSalesman = sel?.kind === 'salesman' ? rows.find((r) => r.id === sel.id) : undefined
  const originSalesman = origin?.kind === 'salesman' ? rows.find((r) => r.id === origin.id) : undefined
  const selectedSalesmanId = origin?.kind === 'salesman' ? String(origin.id) : ''
  // Tracking always shows the whole of India first (also after picking a salesman); clicking the salesman icon zooms in.
  const mapFitKey = mode === 'tracking' ? `india-${selectedSalesmanId}` : fitKey

  async function loadNearby(o: NonNullable<Origin>, r: Radius) {
    setBusy(true); setMsg('')
    try {
      const q = o.kind === 'salesman' ? `salesman_id=${o.id}` : `latitude=${o.lat.toFixed(6)}&longitude=${o.lng.toFixed(6)}`
      setNearby(await api<Nearby>(`/api/management/field/nearby-dealers/?${q}&radius_km=${r}`))
      setFitKey(`nearby-${o.kind}-${o.kind === 'salesman' ? o.id : `${o.lat},${o.lng}`}-${r}`)
    } catch (e) {
      setNearby(null)
      const body = (e as { data?: Record<string, unknown> }).data
      setMsg(typeof body?.salesman_id === 'string' ? body.salesman_id : Array.isArray(body?.salesman_id) ? String(body.salesman_id[0]) : 'Could not load nearby dealers.')
    } finally { setBusy(false) }
  }

  async function loadNearest(dealerId: number, stale: boolean) {
    setBusy(true); setMsg('')
    try {
      setNearest(await api<Nearest>(`/api/management/field/dealers/${dealerId}/nearest-salesmen/?limit=8${stale ? '&include_stale=true' : ''}`))
      setFitKey(`dealer-${dealerId}`)
    } catch (e) {
      setNearest(null)
      const body = (e as { data?: { dealer?: string[] | string } }).data
      const d = body?.dealer
      setMsg(Array.isArray(d) ? d[0] : d ?? 'Could not load nearest salesman.')
    } finally { setBusy(false) }
  }

  function chooseSalesman(id: number) {
    setPick(false); setSel({ kind: 'salesman', id }); setNearest(null); setTrack(null); setOrigin({ kind: 'salesman', id })
    const s = rows.find((r) => r.id === id)
    if (mode === 'tracking') { setNearby(null); setMsg('') }
    else if (s && s.last_fix) void loadNearby({ kind: 'salesman', id }, radius)
    else { setNearby(null); setMsg(s?.on_duty ? 'On duty, but no position has arrived yet.' : 'No location has been recorded for this salesman yet.') }
    if (s?.last_fix) setFitKey(`sel-${id}`)
  }

  function changeSalesman(value: string) {
    if (value) { chooseSalesman(Number(value)); return }
    setSel(null); setOrigin(null); setNearby(null); setNearest(null); setTrack(null); setMsg(''); setPick(false)
  }

  function chooseDealer(id: number) {
    setPick(false); setSel({ kind: 'dealer', id }); setTrack(null); setNearest(null)
    if (mode === 'nearby') void loadNearest(id, includeStale)
  }

  function onMapClick(lat: number, lng: number) {
    if (!pick) return
    setSel(null); setNearest(null); setTrack(null)
    const o: Origin = { kind: 'point', lat, lng }
    setOrigin(o); void loadNearby(o, radius)
  }

  function changeRadius(r: Radius) { setRadius(r); if (origin) void loadNearby(origin, r) }

  async function showRoute(id: number) {
    setBusy(true); setMsg('')
    try {
      const t = await api<Track>(`/api/management/field/salesmen/${id}/track/`)
      setTrack(t); setFitKey(`track-${id}-${t.total_points}`)
      if (t.total_points === 0) setMsg('No route recorded today.')
    } catch { setMsg('Could not load the route.') } finally { setBusy(false) }
  }

  async function forceEnd(id: number, name: string) {
    if (!(await confirm({ title: `End ${name}'s duty?`, message: 'Their location recording stops now. This is recorded in the audit log.', confirmLabel: 'End duty', danger: true }))) return
    await api(`/api/management/field/salesmen/${id}/end-session/`, { method: 'POST' }).catch(() => setMsg('Could not end the session.'))
    void poll()
  }

  const markers: MapMarker[] = useMemo(() => {
    const m: MapMarker[] = []
    for (const s of rows) {
      if (!s.last_fix) continue
      if (mode === 'tracking' && (origin?.kind !== 'salesman' || origin.id !== s.id)) continue
      const st = s.shownStatus
      m.push({
        id: `s${s.id}`, kind: 'salesman', status: st, lat: s.last_fix.latitude, lng: s.last_fix.longitude,
        label: s.name, initial: s.name.trim().charAt(0).toUpperCase(),
        detail: `${s.on_duty ? STATUS_META[st].label : 'Last seen'} · position ${fmtAge(s.shownAge)} · ${fmtAccuracy(s.last_fix.accuracy_m)}`,
        selected: sel?.kind === 'salesman' && sel.id === s.id,
      })
    }
    const dealers: (DealerPin & { straight_line_m?: number })[] = mode === 'tracking' ? dealerMap?.results ?? [] : nearby?.results ?? []
    for (const d of dealers) {
      m.push({ id: `d${d.id}`, kind: 'dealer', lat: d.latitude, lng: d.longitude, verified: d.location_verified, label: d.name,
        detail: [d.straight_line_m !== undefined ? `${fmtDistance(d.straight_line_m)} straight-line` : '', d.shop_name,
          [d.address, d.city, d.state].filter(Boolean).join(', '), d.phone, d.location_verified ? 'Verified location' : 'Location not verified'].filter(Boolean).join(' · '),
        selected: sel?.kind === 'dealer' && sel.id === d.id })
    }
    if (nearest && !m.some((x) => x.id === `d${nearest.dealer.id}`)) {
      m.push({ id: `d${nearest.dealer.id}`, kind: 'target', lat: nearest.dealer.latitude, lng: nearest.dealer.longitude, label: nearest.dealer.name, selected: true })
    }
    if (origin?.kind === 'point') m.push({ id: 'origin', kind: 'origin', lat: origin.lat, lng: origin.lng, label: 'Search point' })
    return m
  }, [rows, nearby, nearest, origin, sel, mode, dealerMap])

  const circles = useMemo(() => nearby ? [{ lat: nearby.origin.latitude, lng: nearby.origin.longitude, radiusM: nearby.radius_km * 1000, tone: 'blue' as const }] : [], [nearby])
  const line = useMemo(() => track?.points.map((p) => [p.latitude, p.longitude] as [number, number]), [track])
  const onMarkerClick = useCallback((m: MapMarker) => {
    if (m.id.startsWith('s')) chooseSalesman(Number(m.id.slice(1)))
    else if (m.id.startsWith('d')) chooseDealer(Number(m.id.slice(1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, radius, includeStale, mode])

  const counts = live?.counts

  return (
    <>
      <PageHeader title={mode === 'nearby' ? 'Nearby Dealers' : 'Live Salesman Tracking'}
        subtitle={mode === 'nearby' ? 'Find dealers within 1, 3, 5, 10 or 20 km of a salesman or any point on the map, and see who is closest to a dealer.' : 'Saved dealer locations across India. Select a salesman to see their position.'}
        action={<div className="flex items-center gap-3 text-sm text-slate-500">
          {live && <span>Updated {fmtTime(live.generated_at)}</span>}
          <Button variant="secondary" size="sm" onClick={() => { void poll(); void pollDealers() }}>Refresh</Button>
        </div>} />

      {pollError && (
        <p role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Live updates are paused (could not reach the server). Positions below are from {polledAt ? fmtAge(elapsed) : 'earlier'} and their status is aging accordingly.
        </p>
      )}

      <div className={mode === 'nearby' ? 'grid gap-5 lg:grid-cols-[22rem_1fr]' : 'flex flex-col gap-4'}>
        <aside className={mode === 'nearby' ? 'flex max-h-[calc(100vh-14rem)] min-h-[28rem] flex-col gap-4 overflow-auto whitespace-normal' : 'w-full max-w-sm'}>
          <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
            Salesman
            <select value={selectedSalesmanId} onChange={(e) => changeSalesman(e.target.value)} disabled={!live || rows.length === 0}
              className="h-11 w-full rounded-lg border bg-white px-3 text-sm font-normal text-slate-900 disabled:text-slate-400">
              <option value="">{!live ? pollError ? 'Could not load salesman names' : 'Loading names...' : rows.length ? 'Select a salesman' : 'No salesman available'}</option>
              {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {mode === 'tracking' && originSalesman && (
            <p role="status" className="mt-2 text-sm text-slate-500">
              {originSalesman.last_fix
                ? originSalesman.on_duty
                  ? `${STATUS_META[originSalesman.shownStatus].label} · location ${fmtAge(originSalesman.shownAge)} · tap the blue icon to zoom in`
                  : `App closed · last seen ${fmtAge(originSalesman.shownAge)} (${fmtTime(originSalesman.last_fix.captured_at)}) · tap the blue icon to zoom in`
                : originSalesman.on_duty ? 'App open. Waiting for this salesman’s GPS location (location permission must be allowed).' : 'No location recorded yet. The salesman must open the app and allow location.'}
            </p>
          )}

          {mode === 'nearby' && <>

          <div className="rounded-xl border bg-white p-4 shadow-card">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Nearby dealers</h2>
              <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={pick} onChange={(e) => setPick(e.target.checked)} />Pick a point on the map</label>
            </div>
            <div className="mt-3"><Pills value={radius} options={RADII.map((r) => [r, `${r} km`] as [Radius, string])} onChange={changeRadius} /></div>
            {pick && <p className="mt-2 text-xs text-primary">Click anywhere on the map to list dealers around that point.</p>}
            {!origin && !pick && <p className="mt-2 text-xs text-slate-500">Select a salesman, or pick a point on the map.</p>}
            {msg && <p role="status" className="mt-2 text-sm text-amber-800">{msg}</p>}
            {nearby && (
              <>
                <p className="mt-3 text-sm text-slate-600">
                  {nearby.origin.salesman_id !== undefined && nearby.origin.status && nearby.origin.status !== 'live' && (
                    <Badge tone="blue">From a {STATUS_META[nearby.origin.status].label.toLowerCase()} position</Badge>
                  )}{' '}
                  {nearby.total} dealer{nearby.total === 1 ? '' : 's'} within {nearby.radius_km} km{nearby.truncated ? ` (nearest ${nearby.results.length} shown)` : ''}
                </p>
                <ul className="mt-2 max-h-64 divide-y overflow-auto text-sm">
                  {nearby.results.map((d) => (
                    <li key={d.id}>
                      <button onClick={() => chooseDealer(d.id)} className={`block w-full py-2 text-left ${sel?.kind === 'dealer' && sel.id === d.id ? 'bg-primary-soft' : 'hover:bg-slate-50'}`}>
                        <div className="flex justify-between gap-2"><span className="font-medium">{d.name}</span><span className="shrink-0 text-slate-600">{fmtDistance(d.straight_line_m)}</span></div>
                        <div className="text-xs text-slate-500">{[d.city, d.state].filter(Boolean).join(', ')}{d.owner ? ` · ${d.owner.name}` : ' · unassigned'}{d.location_verified ? '' : ' · unverified location'}</div>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">{nearby.distance_note}</p>
              </>
            )}
          </div>

          {selSalesman && (
            <div className="rounded-xl border bg-white p-4 shadow-card text-sm">
              <h2 className="font-semibold">{selSalesman.name}</h2>
              <p className="text-slate-500">{selSalesman.phone}</p>
              <p className="mt-2"><StatusBadge status={selSalesman.shownStatus} /> <span className="text-slate-600">{STATUS_META[selSalesman.shownStatus].hint}</span></p>
              <div className="mt-3 flex flex-wrap gap-2">
                {selSalesman.on_duty && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void showRoute(selSalesman.id)}>Show today's route</Button>}
                {me.role === 'admin' && selSalesman.on_duty && <Button variant="danger" size="sm" onClick={() => void forceEnd(selSalesman.id, selSalesman.name)}>End duty</Button>}
                <Link to={`/salesmen/${selSalesman.id}`} className={buttonClass('secondary', 'sm')}>Profile</Link>
              </div>
              {track && <p className="mt-2 text-xs text-slate-500">{track.total_points} point{track.total_points === 1 ? '' : 's'} today{track.downsampled ? ' (thinned for display)' : ''}. Opening a route is recorded in the audit log.</p>}
            </div>
          )}

          {sel?.kind === 'dealer' && (
            <div className="rounded-xl border bg-white p-4 shadow-card text-sm">
              <h2 className="font-semibold">Closest salesman{nearest ? ` to ${nearest.dealer.name}` : ''}</h2>
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={includeStale} onChange={(e) => { setIncludeStale(e.target.checked); void loadNearest(sel.id, e.target.checked) }} />
                Include salesman whose position is stale
              </label>
              {nearest && nearest.results.length === 0 && <p className="mt-3 text-slate-500">No on-duty salesman with a {includeStale ? '' : 'live '}position.</p>}
              <ul className="mt-2 divide-y">
                {nearest?.results.map((r) => (
                  <li key={r.salesman_id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <button onClick={() => chooseSalesman(r.salesman_id)} className="font-medium underline-offset-2 hover:underline">{r.name}</button>
                      <span className="font-semibold">{fmtDistance(r.straight_line_m)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <StatusBadge status={r.status} /> position {fmtAge(r.age_s)}{r.is_owner ? ' · dealer\'s own salesman' : ''}
                    </div>
                  </li>
                ))}
              </ul>
              {nearest && (
                <>
                  <p className="mt-2 text-xs text-slate-500">{nearest.distance_note}</p>
                  <a href={directionsUrl(nearest.dealer.latitude, nearest.dealer.longitude)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-primary">Driving directions to the dealer ↗</a>
                </>
              )}
            </div>
          )}
          </>}
        </aside>

        <section aria-label="Map" className="min-w-0">
          {mode === 'tracking' && <div className="mb-3 text-sm text-slate-500">
            {dealerError && <p role="alert" className="text-amber-800">Could not refresh dealer locations. Click Refresh to retry.</p>}
            {!dealerMap && !dealerError && <p role="status">Loading saved dealer locations...</p>}
            {dealerMap?.total === 0 && <p>No dealers saved yet. Dealers with saved coordinates will appear here.</p>}
          </div>}
          <LeafletMap className="h-[calc(100vh-16rem)] min-h-[28rem]" label={mode === 'tracking' ? 'India dealer locations and selected salesman' : 'Map of on-duty salesman and nearby dealers'} markers={markers} circles={circles} line={line}
            fitKey={mapFitKey} onMarkerClick={onMarkerClick} onMapClick={mode === 'nearby' && pick ? onMapClick : undefined} zoomOnSalesmanClick={mode === 'tracking'} />
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600" aria-label="Map legend">
            <span className="flex items-center gap-1.5"><MapPin size={18} className="text-red-600" aria-hidden />Dealer location</span>
            <span className="flex items-center gap-1.5"><span className="grid size-5 place-items-center rounded-full bg-blue-600 text-white"><UserRound size={13} aria-hidden /></span>Salesman position</span>
          </div>
          {mode === 'nearby' && <><div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 whitespace-normal text-xs text-slate-600">
            <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white bg-blue-600 shadow" />Live (position within {live ? Math.round(live.thresholds.live_s / 60) : 2} min)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-600" />Amber dot: stale, may have moved</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-500" />Grey dot: signal lost or app closed</span>
            <span className="flex items-center gap-1.5"><MapPin size={16} className="text-red-600" aria-hidden />Dealer, solid outline = verified; dashed = not verified</span>
          </div>
          {counts && counts.off_duty > 0 && <p className="mt-2 text-xs text-slate-500">{counts.off_duty} salesm{counts.off_duty === 1 ? 'an has' : 'en have'} the app closed: their last known position is shown in grey.</p>}
          <p className="mt-1 text-xs text-slate-500">Map data © OpenStreetMap contributors. Dealers without a saved location are not shown; <Link to="/dealer-locations" className="text-primary">fix them in Dealer Locations</Link>.</p></>}
        </section>
      </div>
    </>
  )
}
