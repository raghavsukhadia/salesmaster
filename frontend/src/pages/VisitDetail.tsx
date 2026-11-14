import { Link, useParams } from 'react-router-dom'
import { Badge, fmtDate, fmtTime, useApi } from '../components/ui'
import { fmtDue, visitStatus } from '../visit/format.ts'
import { fmtInr } from '../visit/orderMath.ts'
import type { FollowupRow } from './Followups'
import VisitPhotos, { type VisitPhoto } from '../visit/VisitPhotos'

interface Detail {
  id: number; visited_at: string; source: string; notes: string; status: string; order_total: number; salesman: string
  dealer: { id: number; name: string; shop_name: string; phone: string; city: string; state: string; address: string }
  location: { lat: number | null; lng: number | null; source: string; captured_at: string | null }
  order_items: { name: string; quantity: number; unit: string; unit_price: number; line_total: number }[]
  interests: string[]
  followups: FollowupRow[]
  photos?: VisitPhoto[]
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rounded border p-3"><h2 className="mb-2 font-semibold">{title}</h2>{children}</section>
)

export default function VisitDetail() {
  const { id } = useParams()
  const { data: v, loading, error } = useApi<Detail>(`/api/salesman/visits/${id}/`)

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Link to="/visit-history" className="text-sm underline">← Visit history</Link>
      {loading && <p className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">Visit not found, or it is not available to you.</p>}
      {v && (
        <>
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{v.dealer.name}<Badge tone={visitStatus(v.status).tone}>{visitStatus(v.status).label}</Badge></h2>
            <p className="text-sm text-slate-500">
              {[v.dealer.shop_name, [v.dealer.city, v.dealer.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {fmtDate(v.visited_at)} {fmtTime(v.visited_at)} {v.source === 'whatsapp' && <Badge tone="gray">WhatsApp</Badge>}
            </p>
            {v.dealer.phone && <a href={`tel:${v.dealer.phone}`} className="mt-2 inline-block rounded border px-3 py-2 text-sm">Call dealer · {v.dealer.phone}</a>}
          </div>

          <Section title="Notes">{v.notes ? <p className="whitespace-pre-wrap text-sm">{v.notes}</p> : <p className="text-sm text-slate-500">No notes.</p>}</Section>

          <VisitPhotos photos={v.photos} wrapClass="rounded border p-3" headingClass="mb-2 font-semibold" />

          <Section title="Order">
            {v.order_items.length ? (
              <>
                <ul className="divide-y text-sm">
                  {v.order_items.map((i, n) => (
                    <li key={n} className="flex items-baseline justify-between gap-3 py-1.5">
                      <span>{i.name} – {v.salesman}</span>
                      <span className="text-right text-slate-600">
                        {i.quantity} {i.unit}{i.unit_price > 0 && <> × {fmtInr(i.unit_price)} = <strong className="tabular-nums text-slate-900">{fmtInr(i.line_total)}</strong></>}
                      </span>
                    </li>
                  ))}
                </ul>
                {v.order_total > 0 && <p className="mt-2 flex justify-between border-t pt-2 text-sm font-semibold"><span>Order total</span><span className="tabular-nums" data-testid="visit-order-total">{fmtInr(v.order_total)}</span></p>}
              </>
            ) : <p className="text-sm text-slate-500">No order on this visit.</p>}
          </Section>

          {v.interests.length > 0 && <Section title="Interested in"><p className="text-sm">{v.interests.join(', ')}</p></Section>}

          <Section title="Location">
            {v.location.lat != null && v.location.lng != null ? (
              <p className="text-sm">
                {v.location.lat.toFixed(5)}, {v.location.lng.toFixed(5)}{v.location.source && <span className="text-slate-500"> · {v.location.source}</span>}
                {' · '}<a className="underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${v.location.lat},${v.location.lng}`}>Open map</a>
              </p>
            ) : <p className="text-sm text-slate-500">No location captured.</p>}
          </Section>

          <Section title="Follow-up">
            {v.followups.length ? (
              <ul className="divide-y text-sm">
                {v.followups.map((f) => (
                  <li key={f.id} className="flex items-center justify-between py-1.5">
                    <span>{fmtDue(f.due_date, f.due_time)}{f.notes && <span className="text-slate-500"> · {f.notes}</span>}</span>
                    <Badge tone={f.state === 'overdue' ? 'red' : f.state === 'completed' ? 'green' : f.status === 'cancelled' ? 'gray' : 'blue'}>{f.state.replace('_', ' ')}</Badge>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No follow-up scheduled.</p>}
            <Link to="/followups" className="mt-2 inline-block text-sm underline">Go to follow-ups</Link>
          </Section>
        </>
      )}
    </div>
  )
}
