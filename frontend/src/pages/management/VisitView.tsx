import { Link, useParams } from 'react-router-dom'
import { MapPin } from 'lucide-react'
import { Badge, fmtDate, fmtTime, useApi } from '../../components/ui'
import LeafletMap, { type MapMarker } from '../../components/LeafletMap'
import VisitPhotos, { type VisitPhoto } from '../../visit/VisitPhotos'
import { fmtDue } from '../../visit/format.ts'
import { fmtInr } from '../../visit/orderMath.ts'

interface Pt { lat: number | null; lng: number | null }
interface Detail {
  id: number; visited_at: string; recorded_at: string; source: string; notes: string
  dealer: { id: number; name: string; shop_name: string; phone: string; whatsapp: string; address: string; city: string; state: string; pincode: string; gst_number: string; status: string; archived: boolean; owner: string | null }
  salesman: { id: number; name: string; phone: string; email: string; active: boolean }
  location: { visit: Pt; salesman: Pt; dealer: Pt; source: string; captured_at: string | null; distance_from_dealer_m: number | null }
  order: { has_order: boolean; items: { id: number; name: string; quantity: number; unit: string; unit_price: number; line_total: number; catalogue: boolean }[]; total_quantity: number; total_amount: number }
  interests: string[]
  photos?: VisitPhoto[]
  followups: { id: number; due_date: string; due_time: string | null; priority: string; status: string; outcome: string; task: string; notes: string; state: string }[]
}

const card = 'mb-5 rounded-2xl border bg-white p-5'
export const OUTCOME: Record<string, string> = { interested: 'Interested', call_again: 'Call again', send_quotation: 'Send quotation', no_answer: 'No answer', not_interested: 'Not interested' }
export const STATE: Record<string, ['red' | 'blue' | 'gray' | 'green', string]> = {
  overdue: ['red', 'Overdue'], due_today: ['blue', 'Due Today'], upcoming: ['gray', 'Upcoming'], completed: ['green', 'Completed'], cancelled: ['gray', 'Cancelled'],
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-0.5 text-sm">{children || '—'}</dd></div>
}

/** A field that only appears when it has a value: empty points are hidden instead of showing "—" or "Not captured". */
function Opt({ label, children }: { label: string; children: React.ReactNode }) {
  return children ? <Field label={label}>{children}</Field> : null
}

const fmtDistance = (m: number | null) => (m === null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`)
const SOURCE: Record<string, string> = { browser_gps: 'Phone GPS', gps_checkin: 'GPS check-in' }

export function coords(p: Pt) {
  if (p.lat === null || p.lng === null) return null
  return `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`
}

function MapLink({ p }: { p: Pt }) {
  const c = coords(p)
  if (!c) return null
  return <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className="ml-2 text-primary hover:underline">Open map ↗</a>
}

const same = (a: Pt, b: Pt) => coords(a) !== null && coords(a) === coords(b)

/** How close the visit was to the dealer's saved shop location, in words a manager can act on. */
function verdict(m: number | null): { tone: string; text: string } | null {
  if (m === null) return null
  if (m <= 200) return { tone: 'border-green-200 bg-green-50 text-green-800', text: `At the shop · ${fmtDistance(m)} away` }
  if (m <= 1000) return { tone: 'border-amber-200 bg-amber-50 text-amber-900', text: `Near the shop · ${fmtDistance(m)} away` }
  return { tone: 'border-red-200 bg-red-50 text-red-800', text: `Away from the shop · ${fmtDistance(m)} away` }
}

function VisitLocation({ l, dealerName, source, captured }: { l: Detail['location']; dealerName: string; source: string; captured: string }) {
  const v = verdict(l.distance_from_dealer_m)
  // Identical points are listed once: a salesman fix equal to the visit fix is the same reading.
  const points: { key: string; label: string; p: Pt; dot: string }[] = []
  if (coords(l.visit)) points.push({ key: 'visit', label: 'Visited here (GPS)', p: l.visit, dot: 'bg-blue-600' })
  if (coords(l.salesman) && !same(l.salesman, l.visit)) points.push({ key: 'salesman', label: 'Salesman location', p: l.salesman, dot: 'bg-blue-400' })
  if (coords(l.dealer)) points.push({ key: 'dealer', label: same(l.dealer, l.visit) ? 'Dealer’s shop (same spot)' : 'Dealer’s shop', p: l.dealer, dot: 'bg-red-500' })
  const markers: MapMarker[] = []
  const here = coords(l.visit) ? l.visit : coords(l.salesman) ? l.salesman : null
  if (coords(l.dealer)) markers.push({ id: 'd', kind: 'dealer', lat: l.dealer.lat!, lng: l.dealer.lng!, label: dealerName, detail: 'Dealer’s saved shop location' })
  if (here) markers.push({ id: 's', kind: 'salesman', status: 'live', lat: here.lat!, lng: here.lng!, label: 'Visit location', initial: 'V', detail: captured ? `Captured ${captured}` : undefined })

  return (
    <section aria-labelledby="loc-h" className="mb-5 overflow-hidden rounded-2xl border-2 border-primary/25 bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-primary-soft px-5 py-3">
        <h2 id="loc-h" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-white"><MapPin size={16} aria-hidden /></span>Visited location
        </h2>
        {v && <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${v.tone}`}>{v.text}</span>}
      </div>
      {markers.length > 0 && <LeafletMap className="h-56 rounded-none border-x-0 border-t-0" label="Visit location map" markers={markers} fitKey={`visit-${markers.map((m) => `${m.lat},${m.lng}`).join('|')}`} />}
      <div className="p-5">
        <ul className="space-y-3">
          {points.map((x) => (
            <li key={x.key} className="flex items-start gap-3">
              <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${x.dot}`} aria-hidden />
              <div className="min-w-0 text-sm">
                <p className="text-xs font-medium text-slate-500">{x.label}</p>
                <p className="font-medium text-slate-900">{coords(x.p)} <MapLink p={x.p} /></p>
              </div>
            </li>
          ))}
        </ul>
        {(source || captured) && (
          <div className="mt-4 flex flex-wrap gap-2 border-t pt-3 text-xs">
            {source && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">Source: {source}</span>}
            {captured && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">Captured {captured}</span>}
          </div>
        )}
      </div>
    </section>
  )
}

export default function VisitView() {
  const { id } = useParams()
  const { data: v, loading, error } = useApi<Detail>(`/api/management/visits/${id}/`)
  if (loading) return <p className="text-slate-500">Loading…</p>
  if (error || !v) return <div><Link to="/visits" className="text-primary hover:underline">← Back to visits</Link><p role="alert" className="mt-3 text-red-700">Visit not found or could not be loaded.</p></div>
  const { dealer: d, salesman: s, location: l, order: o } = v
  const pin = (p: Pt) => coords(p) && <><span>{coords(p)}</span><MapLink p={p} /></>
  const location = {
    visit: pin(l.visit), salesman: pin(l.salesman), dealer: pin(l.dealer), source: SOURCE[l.source] ?? l.source,
    captured: l.captured_at ? `${fmtDate(l.captured_at)} ${fmtTime(l.captured_at)}` : '', distance: fmtDistance(l.distance_from_dealer_m),
  }
  const anyLocation = Object.values(location).some(Boolean)
  return (
    <>
      <Link to="/visits" className="mb-2 inline-block text-sm text-primary hover:underline">← Visits</Link>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Visit to {d.name}</h1>
        <Badge tone={o.has_order ? 'green' : 'gray'}>{o.has_order ? 'Order taken' : 'No order'}</Badge>
        <Badge tone="blue">{v.source === 'whatsapp' ? 'WhatsApp' : 'Web'}</Badge>
        <span className="text-sm text-slate-500">{fmtDate(v.visited_at)} · {fmtTime(v.visited_at)}</span>
      </div>

      {/* The visited location comes first and is highlighted. Only what was recorded is shown. */}
      {anyLocation && <VisitLocation l={l} dealerName={d.name} source={location.source} captured={location.captured} />}

      <div className="grid gap-5 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 font-semibold">Dealer</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/dealers/${d.id}`} className="text-primary hover:underline">{d.name}</Link>{d.archived && <span className="ml-2 text-xs text-amber-700">Archived</span>}</Field>
            <Opt label="Shop">{d.shop_name}</Opt>
            <Opt label="Phone">{d.phone}</Opt><Opt label="WhatsApp">{d.whatsapp}</Opt>
            <Opt label="Status">{d.status}</Opt><Field label="Current owner">{d.owner ?? 'Unassigned'}</Field>
            <Opt label="City / State">{[d.city, d.state].filter(Boolean).join(', ')}</Opt><Opt label="Pincode">{d.pincode}</Opt>
            <Opt label="GST">{d.gst_number}</Opt><Opt label="Address">{d.address}</Opt>
          </dl>
        </section>
        <section className={card}>
          <h2 className="mb-3 font-semibold">Salesman</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/salesmen/${s.id}`} className="text-primary hover:underline">{s.name}</Link>{!s.active && <span className="ml-2 text-xs text-slate-500">Inactive</span>}</Field>
            <Opt label="Phone">{s.phone}</Opt><Opt label="Email">{s.email}</Opt>
            <Field label="Recorded at">{`${fmtDate(v.recorded_at)} ${fmtTime(v.recorded_at)}`}</Field>
          </dl>
        </section>
      </div>

      {v.notes.trim() && (
        <section className={card}>
          <h2 className="mb-3 font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap text-sm">{v.notes}</p>
        </section>
      )}

      <VisitPhotos photos={v.photos} wrapClass={card} />

      {(o.has_order || v.interests.length > 0) && <section className={card}>
        <h2 className="mb-3 font-semibold">Order</h2>
        {o.has_order ? (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Product</th><th>Type</th><th className="text-right">Quantity</th><th className="text-right">Price</th><th className="text-right">Amount</th></tr></thead>
            <tbody className="divide-y">
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td className="py-2">{i.name}</td><td className="text-slate-500">{i.catalogue ? 'Catalogue' : 'Custom'}</td><td className="text-right">{i.quantity} {i.unit}</td>
                  <td className="text-right tabular-nums">{i.unit_price ? fmtInr(i.unit_price) : '—'}</td><td className="text-right tabular-nums">{i.unit_price ? fmtInr(i.line_total) : '—'}</td>
                </tr>
              ))}
              <tr className="font-medium"><td className="py-2">Total</td><td /><td className="text-right">{o.total_quantity}</td><td /><td className="text-right tabular-nums" data-testid="admin-order-total">{o.total_amount ? fmtInr(o.total_amount) : '—'}</td></tr>
            </tbody>
          </table>
        ) : null}
        {v.interests.length > 0 && <p className={`${o.has_order ? 'mt-3 ' : ''}text-sm`}><span className="text-slate-500">Product interest: </span>{v.interests.join(', ')}</p>}
      </section>}

      {v.followups.length > 0 && (
      <section className={card}>
        <h2 className="mb-3 font-semibold">Follow-ups from this visit</h2>
        {(
          <ul className="divide-y">
            {v.followups.map((f) => {
              const [tone, label] = STATE[f.state] ?? STATE.upcoming
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <Link to={`/followups-management/${f.id}`} className="font-medium text-primary hover:underline">Due {fmtDue(f.due_date, f.due_time)}</Link>
                  {f.task && <span className="font-medium">{f.task}</span>}
                  <Badge tone={tone}>{label}</Badge><span className="capitalize text-slate-500">{f.priority} priority</span>
                  {f.outcome && <span>{OUTCOME[f.outcome]}</span>}{f.notes && <span className="text-slate-600">{f.notes}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      )}
    </>
  )
}
