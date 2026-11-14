import { useState } from 'react'
import { api } from '../auth'
import { Button, Modal, Pills, fmtTime, useConfirm } from '../components/ui'
import { trackingSummary } from '../field/summary'
import { directionsUrl, fmtAccuracy, fmtDistance } from '../field/format'
import { tracker, useTrackerState } from '../field/useTracker'

const RADII = ['1', '3', '5', '10', '20'] as const
type Radius = (typeof RADII)[number]

interface NearbyDealer {
  id: number; name: string; shop_name: string; phone: string; city: string; state: string
  latitude: number; longitude: number; location_verified: boolean; straight_line_m: number; driving_m: number | null
}
interface NearbyResponse { results: NearbyDealer[]; total: number; truncated: boolean; distance_note: string }
interface Spot { lat: number; lng: number; accuracy: number; at: number }

function ConsentDialog({ notice, retention, onCancel, onConfirm, busy }: { notice: string[]; retention: number; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const [agreed, setAgreed] = useState(false)
  return (
    <Modal title="Go on duty" onClose={onCancel}>
      <p className="text-sm text-slate-600">Before you start, here is exactly what gets recorded:</p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{notice.map((n) => <li key={n}>{n}</li>)}</ul>
      <label className="mt-4 flex items-start gap-3 rounded-xl border p-3 text-sm">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5" />
        <span>I understand that my location is recorded while I am on duty and kept for {retention} days.</span>
      </label>
      <div className="mt-4 flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button className="flex-1" disabled={!agreed} loading={busy} onClick={onConfirm}>Start duty</Button>
      </div>
    </Modal>
  )
}

function NearbyDealers({ live }: { live: Spot | null }) {
  const [radius, setRadius] = useState<Radius>('5')
  const [spot, setSpot] = useState<Spot | null>(null)
  const [data, setData] = useState<NearbyResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function search(at: Spot, r: Radius) {
    setBusy(true); setError('')
    try {
      setData(await api<NearbyResponse>(`/api/field/nearby-dealers/?latitude=${at.lat.toFixed(6)}&longitude=${at.lng.toFixed(6)}&radius_km=${r}`))
    } catch {
      setError('Could not load nearby dealers. Check your connection and try again.')
    } finally { setBusy(false) }
  }

  function locate(r: Radius) {
    // While on duty the tracker already has a recent fix; otherwise ask the browser once.
    if (live && Date.now() - live.at < 120_000) { setSpot(live); void search(live, r); return }
    if (!navigator.geolocation) return setError('This browser cannot provide your location.')
    setBusy(true); setError('')
    navigator.geolocation.getCurrentPosition(
      (p) => { const s = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }; setSpot(s); void search(s, r) },
      (e) => { setBusy(false); setError(e.code === 1 ? 'Location access is blocked. Allow it in your browser settings.' : 'Could not get your position. Try again outside or near a window.') },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    )
  }

  function pick(r: Radius) { setRadius(r); if (spot) void search(spot, r) }

  return (
    <section className="mt-8" aria-labelledby="nearby-h">
      <h2 id="nearby-h" className="text-lg font-semibold">Dealers near me</h2>
      <p className="mt-1 text-sm text-slate-500">Dealers you own or have access to, around where you are now.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Pills value={radius} options={RADII.map((r) => [r, `${r} km`] as [Radius, string])} onChange={pick} />
        <Button onClick={() => locate(radius)} loading={busy}>{busy ? 'Searching…' : data ? 'Refresh' : 'Find dealers near me'}</Button>
      </div>
      {spot && spot.accuracy > 100 && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">GPS accuracy is only {fmtAccuracy(spot.accuracy)}, so distances may be off by about that much.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {data && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">{data.total === 0 ? `No dealers within ${radius} km.` : `${data.total} dealer${data.total === 1 ? '' : 's'} within ${radius} km${data.truncated ? ` (showing the nearest ${data.results.length})` : ''}`}</p>
          <ul className="mt-2 divide-y rounded-xl border">
            {data.results.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{d.name}{d.shop_name ? <span className="font-normal text-slate-500"> · {d.shop_name}</span> : null}</div>
                  <div className="text-sm text-slate-500">{[d.city, d.state].filter(Boolean).join(', ') || '—'}</div>
                  <div className="mt-1 text-sm"><span className="font-medium">{fmtDistance(d.straight_line_m)}</span> <span className="text-slate-500">straight-line</span>
                    {!d.location_verified && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Location not verified</span>}</div>
                </div>
                <div className="flex shrink-0 flex-col gap-2 text-center text-sm">
                  <a href={directionsUrl(d.latitude, d.longitude)} target="_blank" rel="noreferrer" className="rounded-lg border px-3 py-2 font-medium">Directions ↗</a>
                  {d.phone && <a href={`tel:${d.phone}`} className="rounded-lg border px-3 py-2">Call</a>}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">{data.distance_note}</p>
        </div>
      )}
    </section>
  )
}

export default function Field() {
  const s = useTrackerState() // DutyBanner (rendered by Guard on every salesman page) owns initialisation
  const [asking, setAsking] = useState(false)
  const confirm = useConfirm()
  const { tone, text } = trackingSummary(s)
  const duty = s.duty
  const on = !!duty?.on_duty
  const big = { green: 'border-green-300 bg-green-50', amber: 'border-amber-300 bg-amber-50', red: 'border-red-300 bg-red-50', gray: 'border-slate-200 bg-slate-50' }[tone]
  const fix = duty?.session?.last_fix
  const live: Spot | null = s.position && on ? { lat: s.position.latitude, lng: s.position.longitude, accuracy: s.position.accuracy_m, at: s.position.t } : null

  return (
    <div className="max-w-2xl">
      <section aria-labelledby="duty-h" className={`rounded-2xl border-2 p-4 ${big}`}>
        <h2 id="duty-h" className="text-lg font-semibold">{!s.loaded ? 'Duty status' : s.pendingEnd ? 'Ending duty…' : on ? 'You are on duty' : 'You are off duty'}</h2>
        <p className="mt-1 text-sm">{text}</p>
        {s.error && <p role="alert" className="mt-2 text-sm text-red-700">{s.error}</p>}

        {on && !s.pendingEnd && (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt className="text-slate-500">On duty since</dt><dd className="font-medium">{duty?.session ? fmtTime(duty.session.started_at) : '—'}</dd></div>
            <div><dt className="text-slate-500">GPS accuracy</dt><dd className="font-medium">{s.position ? fmtAccuracy(s.position.accuracy_m) : '—'}</dd></div>
            <div><dt className="text-slate-500">Last upload</dt><dd className="font-medium">{s.lastUploadAt ? fmtTime(new Date(s.lastUploadAt).toISOString()) : '—'}</dd></div>
            <div><dt className="text-slate-500">Waiting to sync</dt><dd className="font-medium">{s.queued}</dd></div>
          </dl>
        )}
        {s.discarded > 0 && <p className="mt-2 text-xs text-slate-600">{s.discarded} point(s) could not be uploaded and were discarded.</p>}
        {s.gps === 'denied' && (
          <p className="mt-2 text-sm text-red-800">To fix this: open your browser's site settings for this page, set Location to Allow, then reload.</p>
        )}
        {fix && on && !s.position && <p className="mt-2 text-xs text-slate-500">Last position the server has: {fmtAccuracy(fix.accuracy_m)}</p>}

        <div className="mt-4">
          {!s.loaded ? null : s.pendingEnd ? (
            <p className="text-sm text-slate-600">No more locations will be recorded from this phone.</p>
          ) : on ? (
            <Button className="h-14 w-full text-lg" loading={s.busy} onClick={async () => { if (await confirm({ title: 'End duty?', message: 'Location recording stops immediately.', confirmLabel: 'End duty' })) void tracker.end() }}>End duty</Button>
          ) : (
            <Button className="h-14 w-full bg-green-600 text-lg hover:bg-green-700" disabled={!duty} loading={s.busy} onClick={() => setAsking(true)}>Start duty</Button>
          )}
        </div>
        {on && <p className="mt-3 text-xs text-slate-600">This web app records only while it is open. Keep this page or any Sales Master page open, with the screen on, and allow location access.</p>}
      </section>

      {duty && (
        <details className="mt-4 rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">What is recorded, and who can see it</summary>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">{duty.policy.notice.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      )}

      <NearbyDealers live={live} />

      {asking && duty && (
        <ConsentDialog notice={duty.policy.notice} retention={duty.policy.retention_days} busy={s.busy} onCancel={() => setAsking(false)}
          onConfirm={() => { void tracker.start().then(() => setAsking(false)) }} />
      )}
    </div>
  )
}
