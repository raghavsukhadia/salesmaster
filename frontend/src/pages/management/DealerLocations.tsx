import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../../auth'
import LeafletMap, { type MapMarker } from '../../components/LeafletMap'
import { Badge, Button, flatten, fmtDate, fmtTime, Modal, PageHeader, Pager, Pills, SearchBox, StatStrip, Table, useApi, useDebounced, qs } from '../../components/ui'
import { fmtAccuracy } from '../../field/format'

interface LocEvent { id: number; at: string; event: 'captured' | 'updated' | 'verified'; by: string; by_role: string; latitude: number | null; longitude: number | null; accuracy_m: number | null }
const EVENT_LABEL: Record<LocEvent['event'], [string, 'blue' | 'amber' | 'green']> = {
  captured: ['Captured by salesman', 'blue'], updated: ['Location changed', 'amber'], verified: ['Verified', 'green'],
}
const SOURCE_LABEL: Record<string, string> = { manual: 'manual', map_pin: 'map pin', geocoded: 'geocoded', gps_checkin: 'salesman GPS', import: 'imported' }

/** Who captured, changed or verified this dealer's location, and when. */
function LocationHistory({ id }: { id: number }) {
  const { data, loading, error } = useApi<{ history: LocEvent[] }>(`/api/management/dealers/${id}/location/`)
  return (
    <div className="mt-5 border-t pt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase text-slate-500">Location history</h3>
        <Link to={`/dealers/${id}`} className="text-xs text-primary hover:underline">Full dealer history →</Link>
      </div>
      {loading && !data && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p role="alert" className="text-sm text-red-600">Could not load the history.</p>}
      {data && (data.history.length ? (
        <ul className="max-h-48 divide-y overflow-y-auto text-sm">
          {data.history.map((h) => (
            <li key={h.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={EVENT_LABEL[h.event][1]}>{EVENT_LABEL[h.event][0]}</Badge>
                <span>by <b>{h.by}</b>{h.by_role && <span className="text-slate-500"> ({h.by_role})</span>}</span>
              </span>
              <span className="text-slate-600">
                {fmtDate(h.at, true)} {fmtTime(h.at)}
                {h.latitude != null && h.longitude != null && ` · ${h.latitude.toFixed(5)}, ${h.longitude.toFixed(5)}`}
                {h.accuracy_m != null && ` · ±${Math.round(h.accuracy_m)} m`}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-500">No location history yet. It is captured automatically the first time a salesman visits this dealer.</p>)}
    </div>
  )
}

type Mode = 'all' | 'missing' | 'unverified' | 'verified'
interface Row {
  id: number; name: string; latitude: number | null; longitude: number | null; source: string; accuracy_m: number | null
  verified: boolean; verified_at: string | null; verified_by: string | null; geofence_radius_m: number | null
  has_location: boolean; address: string; city: string; state: string; pincode: string; phone: string
  territory: { state: string; city: string; covered_by: string[] }; contact: { name: string; phone: string } | null
}
interface Data { summary: { total: number; verified: number; unverified: number; missing: number }; count: number; page_size: number; results: Row[] }

const SOURCES: [string, string][] = [['manual', 'Entered manually'], ['map_pin', 'Placed on the map'], ['geocoded', 'Geocoded from the address'], ['import', 'Imported']]

function Editor({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [lat, setLat] = useState(row.latitude?.toString() ?? '')
  const [lng, setLng] = useState(row.longitude?.toString() ?? '')
  const [acc, setAcc] = useState(row.accuracy_m?.toString() ?? '')
  const [source, setSource] = useState(SOURCES.some(([v]) => v === row.source) ? row.source : 'manual')
  const [fence, setFence] = useState(row.geofence_radius_m?.toString() ?? '')
  const [verified, setVerified] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const la = Number(lat), lo = Number(lng)
  const ok = lat.trim() !== '' && lng.trim() !== '' && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)
  const pin: MapMarker[] = ok ? [{ id: 'pin', kind: 'pin', lat: la, lng: lo, label: row.name, selected: true }] : []

  async function save() {
    setBusy(true); setErrors([])
    try {
      await api(`/api/management/dealers/${row.id}/location/`, { method: 'PUT', body: {
        latitude: la, longitude: lo, source, verified,
        ...(acc.trim() !== '' && { accuracy_m: Number(acc) }),
        geofence_radius_m: fence.trim() === '' ? null : Number(fence),
      } })
      onSaved()
    } catch (e) {
      setErrors(e instanceof ApiError ? flatten(e.data) : ['Could not save.'])
    } finally { setBusy(false) }
  }

  const field = 'rounded-lg border px-3 py-2 text-sm'
  return (
    <Modal title={`Location for ${row.name}`} onClose={onClose} width="max-w-3xl">
      <p className="-mt-2 mb-4 text-sm text-slate-500">{[row.address, row.city, row.state, row.pincode].filter(Boolean).join(', ') || 'No address on file'}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">Latitude
            <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="e.g. 18.520400" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">Longitude
            <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" placeholder="e.g. 73.856700" className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-600">How it was captured
              <select value={source} onChange={(e) => setSource(e.target.value)} className={`${field} bg-white`}>{SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Accuracy (m, optional)
              <input value={acc} onChange={(e) => setAcc(e.target.value)} inputMode="decimal" className={field} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-slate-600">Check-in geofence radius (m)
            <input value={fence} onChange={(e) => setFence(e.target.value)} inputMode="numeric" placeholder="Blank = use the default" className={field} />
          </label>
          <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="mt-0.5" />
            <span>I have confirmed this is the dealer's actual location. <span className="text-slate-500">Moving the pin later clears this.</span></span>
          </label>
          {lat !== '' && lng !== '' && !ok && <p role="alert" className="text-sm text-red-600">Enter a valid latitude (-90 to 90) and longitude (-180 to 180). 0, 0 counts as "not set".</p>}
          {errors.map((m) => <p key={m} role="alert" className="text-sm text-red-600">{m}</p>)}
        </div>
        <div>
          <LeafletMap className="h-72" label="Click the map to place the dealer" markers={pin} fitKey={`${row.id}-${row.latitude ?? ''}`}
            onMapClick={(a, b) => { setLat(a.toFixed(6)); setLng(b.toFixed(6)); setSource('map_pin') }} />
          <p className="mt-2 text-xs text-slate-500">Click the map to place the pin, or type coordinates. Zoom in close to the shop entrance.</p>
        </div>
      </div>
      <LocationHistory id={row.id} />
      <div className="mt-5 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!ok} loading={busy} onClick={() => void save()}>Save location</Button>
      </div>
    </Modal>
  )
}

export default function DealerLocations() {
  const [mode, setMode] = useState<Mode>('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [rev, setRev] = useState(0)
  const [editing, setEditing] = useState<Row | null>(null)
  const [note, setNote] = useState('')
  const dq = useDebounced(q)
  const { data, loading, error } = useApi<Data>(`/api/management/field/dealer-locations/?${qs({ status: mode === 'all' ? undefined : mode, q: dq, page })}&r=${rev}`)
  const s = data?.summary
  const pct = useMemo(() => (s && s.total ? Math.round((s.verified / s.total) * 100) : 0), [s])

  async function verify(r: Row) {
    setNote('')
    try { await api(`/api/management/dealers/${r.id}/location/verify/`, { method: 'POST' }); setRev((n) => n + 1) }
    catch { setNote(`Could not verify ${r.name}.`) }
  }

  return (
    <>
      <PageHeader title="Dealer Locations" />
      {s && <StatStrip items={[{ label: 'Dealers', value: s.total }, { label: 'Verified', value: `${s.verified} (${pct}%)` }, { label: 'Unverified', value: s.unverified, tone: s.unverified ? 'amber' : undefined }, { label: 'No location', value: s.missing, tone: s.missing ? 'red' : undefined }]} />}
      <div className="mb-4 flex items-center justify-between">
        <Pills value={mode} onChange={(m) => { setMode(m); setPage(1) }} options={[['all', 'All'], ['missing', 'No location'], ['unverified', 'Unverified'], ['verified', 'Verified']]} />
        <Link to="/field-map" className="text-sm text-primary">Open Field Map →</Link>
      </div>
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search by name, shop, phone, city or pincode" />
      {note && <p role="alert" className="mb-3 text-sm text-red-600">{note}</p>}
      <Table stack loading={loading} error={error} empty={data?.results.length === 0}
        head={[{ label: 'Dealer' }, { label: 'Address' }, { label: 'Territory' }, { label: 'Contact' }, { label: 'Location' }, { label: 'Status' }, { label: '', right: true }]}>
        {data?.results.map((r) => (
          <tr key={r.id} className="align-top">
            <td className="px-3 py-3"><Link to={`/dealers/${r.id}`} className="font-semibold hover:underline">{r.name}</Link><div className="text-xs text-slate-500">{r.phone || 'No phone'}</div></td>
            <td className="px-3 py-3 text-slate-600 sm:max-w-[16rem] sm:truncate" title={r.address}>{[r.address, r.city, r.pincode].filter(Boolean).join(', ') || '—'}</td>
            <td className="px-3 py-3 text-slate-600">{[r.territory.city, r.territory.state].filter(Boolean).join(', ') || '—'}<div className="text-xs text-slate-500">{r.territory.covered_by.length ? `Covered by ${r.territory.covered_by.join(', ')}` : 'No salesman territory'}</div></td>
            <td className="px-3 py-3 text-slate-600">{r.contact ? <>{r.contact.name}<div className="text-xs text-slate-500">{r.contact.phone}</div></> : '—'}</td>
            <td className="px-3 py-3 font-mono text-xs text-slate-600">
              {r.has_location ? <>{r.latitude?.toFixed(5)}, {r.longitude?.toFixed(5)}<div className="font-sans text-slate-500">{fmtAccuracy(r.accuracy_m)}{r.source ? ` · ${SOURCE_LABEL[r.source] ?? r.source.replace('_', ' ')}` : ''}</div></> : '—'}
            </td>
            <td className="px-3 py-3">{!r.has_location ? <Badge tone="red">No location</Badge> : r.verified ? <span title={`${r.verified_by ?? ''}`}><Badge tone="green">Verified</Badge></span> : <Badge tone="gray">Unverified</Badge>}</td>
            <td className="px-3 py-3 text-left sm:text-right sm:whitespace-nowrap">
              {r.has_location && !r.verified && <Button variant="secondary" size="sm" className="mr-2" onClick={() => void verify(r)}>Verify as is</Button>}
              <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>{r.has_location ? 'Edit' : 'Set location'}</Button>
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} size={data?.page_size ?? 25} />
      {editing && <Editor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setRev((n) => n + 1) }} />}
    </>
  )
}
