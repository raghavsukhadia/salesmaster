import { Link, useParams } from 'react-router-dom'
import { Badge, fmtDate, fmtTime, useApi } from '../../components/ui'
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
  followups: { id: number; due_date: string; due_time: string | null; priority: string; status: string; outcome: string; notes: string; state: string }[]
}

const card = 'mb-5 rounded-2xl border bg-white p-5'
export const OUTCOME: Record<string, string> = { interested: 'Interested', call_again: 'Call again', send_quotation: 'Send quotation', no_answer: 'No answer', not_interested: 'Not interested' }
export const STATE: Record<string, ['red' | 'blue' | 'gray' | 'green', string]> = {
  overdue: ['red', 'Overdue'], due_today: ['blue', 'Due Today'], upcoming: ['gray', 'Upcoming'], completed: ['green', 'Completed'], cancelled: ['gray', 'Cancelled'],
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-0.5 text-sm">{children || '—'}</dd></div>
}

export function coords(p: Pt) {
  if (p.lat === null || p.lng === null) return null
  return `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`
}

function MapLink({ p }: { p: Pt }) {
  const c = coords(p)
  if (!c) return null
  return <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className="ml-2 text-primary hover:underline">Open map ↗</a>
}

export default function VisitView() {
  const { id } = useParams()
  const { data: v, loading, error } = useApi<Detail>(`/api/management/visits/${id}/`)
  if (loading) return <p className="text-slate-500">Loading…</p>
  if (error || !v) return <div><Link to="/visits" className="text-primary hover:underline">← Back to visits</Link><p role="alert" className="mt-3 text-red-700">Visit not found or could not be loaded.</p></div>
  const { dealer: d, salesman: s, location: l, order: o } = v
  return (
    <>
      <Link to="/visits" className="mb-2 inline-block text-sm text-primary hover:underline">← Visits</Link>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Visit to {d.name}</h1>
        <Badge tone={o.has_order ? 'green' : 'gray'}>{o.has_order ? 'Order taken' : 'No order'}</Badge>
        <Badge tone="blue">{v.source === 'whatsapp' ? 'WhatsApp' : 'Web'}</Badge>
        <span className="text-sm text-slate-500">{fmtDate(v.visited_at)} · {fmtTime(v.visited_at)}</span>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 font-semibold">Dealer</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/dealers/${d.id}`} className="text-primary hover:underline">{d.name}</Link>{d.archived && <span className="ml-2 text-xs text-amber-700">Archived</span>}</Field>
            <Field label="Shop">{d.shop_name}</Field>
            <Field label="Phone">{d.phone}</Field><Field label="WhatsApp">{d.whatsapp}</Field>
            <Field label="Status">{d.status}</Field><Field label="Current owner">{d.owner ?? 'Unassigned'}</Field>
            <Field label="City / State">{[d.city, d.state].filter(Boolean).join(', ')}</Field><Field label="Pincode">{d.pincode}</Field>
            <Field label="GST">{d.gst_number}</Field><Field label="Address">{d.address}</Field>
          </dl>
        </section>
        <section className={card}>
          <h2 className="mb-3 font-semibold">Salesman</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Name"><Link to={`/salesmen/${s.id}`} className="text-primary hover:underline">{s.name}</Link>{!s.active && <span className="ml-2 text-xs text-slate-500">Inactive</span>}</Field>
            <Field label="Phone">{s.phone}</Field><Field label="Email">{s.email}</Field>
            <Field label="Recorded at">{`${fmtDate(v.recorded_at)} ${fmtTime(v.recorded_at)}`}</Field>
          </dl>
        </section>
      </div>

      <section className={card}>
        <h2 className="mb-3 font-semibold">Location</h2>
        <dl className="grid gap-3 md:grid-cols-3">
          <Field label="Visit location (GPS)">{coords(l.visit) ? <><span>{coords(l.visit)}</span><MapLink p={l.visit} /></> : 'Not captured'}</Field>
          <Field label="Salesman location">{coords(l.salesman) ? <><span>{coords(l.salesman)}</span><MapLink p={l.salesman} /></> : 'Not captured'}</Field>
          <Field label="Dealer location">{coords(l.dealer) ? <><span>{coords(l.dealer)}</span><MapLink p={l.dealer} /></> : 'Not on file'}</Field>
          <Field label="Source">{l.source}</Field>
          <Field label="Captured at">{l.captured_at ? `${fmtDate(l.captured_at)} ${fmtTime(l.captured_at)}` : ''}</Field>
          <Field label="Distance from dealer">{l.distance_from_dealer_m === null ? '' : l.distance_from_dealer_m >= 1000 ? `${(l.distance_from_dealer_m / 1000).toFixed(1)} km` : `${l.distance_from_dealer_m} m`}</Field>
        </dl>
      </section>

      <section className={card}>
        <h2 className="mb-3 font-semibold">Notes</h2>
        <p className="whitespace-pre-wrap text-sm">{v.notes || <span className="text-slate-500">No notes</span>}</p>
      </section>

      <VisitPhotos photos={v.photos} wrapClass={card} />

      <section className={card}>
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
        ) : <p className="text-sm text-slate-500">No order was taken on this visit.</p>}
        {v.interests.length > 0 && <p className="mt-3 text-sm"><span className="text-slate-500">Product interest: </span>{v.interests.join(', ')}</p>}
      </section>

      <section className={card}>
        <h2 className="mb-3 font-semibold">Follow-ups from this visit</h2>
        {v.followups.length === 0 ? <p className="text-sm text-slate-500">No follow-up scheduled.</p> : (
          <ul className="divide-y">
            {v.followups.map((f) => {
              const [tone, label] = STATE[f.state] ?? STATE.upcoming
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <Link to={`/followups-management/${f.id}`} className="font-medium text-primary hover:underline">Due {fmtDue(f.due_date, f.due_time)}</Link>
                  <Badge tone={tone}>{label}</Badge><span className="capitalize text-slate-500">{f.priority} priority</span>
                  {f.outcome && <span>{OUTCOME[f.outcome]}</span>}{f.notes && <span className="text-slate-600">{f.notes}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}
