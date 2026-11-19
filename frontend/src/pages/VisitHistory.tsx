import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, ChevronRight, MapPin, Package, Search } from 'lucide-react'
import { Badge, Card, EmptyState, fmtDate, fmtTime, Pager, qs, useApi, useDebounced } from '../components/ui'
import { fmtDue, localDate, visitStatus } from '../visit/format.ts'
import { fmtInr } from '../visit/orderMath.ts'

interface Row {
  id: number; visited_at: string; dealer: { id: number; name: string; city: string }; notes: string
  source: string; status: string; items: number; has_order: boolean; order_total: number; salesman: string
  order_preview: { name: string; quantity: number; unit: string }[]
  followup_due: string | null; followup_due_time: string | null
}
interface Data { summary: { total: number; orders: number; last_7_days: number }; count: number; results: Row[] }

const field = 'h-10 w-full rounded-lg border bg-white px-3 text-sm'

export default function VisitHistory() {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const reset = (set: (v: string) => void) => (v: string) => { set(v); setPage(1) }
  // A typed From later than To is not sent (the server would reject it); the dates stay visible with a hint instead.
  const badRange = !!(from && to && from > to)
  const { data, loading, error } = useApi<Data>(`/api/salesman/visits/?${qs({ q: dq, from: badRange ? '' : from, to: badRange ? '' : to, status, page })}`)
  const filtered = !!(dq || from || to || status)

  return (
    <div className="flex flex-col gap-4">
      {data && (
        <p className="text-sm text-slate-500" data-testid="visit-summary">
          {data.summary.total} visits · {data.summary.orders} with orders · {data.summary.last_7_days} in the last 7 days
        </p>
      )}
      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_9.5rem_9.5rem_12rem]">
        <div className="relative col-span-2 sm:col-span-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
          <input aria-label="Search visits" placeholder="Search dealer, phone, city or notes" value={q} onChange={(e) => reset(setQ)(e.target.value)} className={`${field} pl-9`} />
        </div>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-slate-500">From</span>
          <input type="date" value={from} max={to || localDate()} onChange={(e) => reset(setFrom)(e.target.value)} className={field} aria-invalid={badRange || undefined} />
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-slate-500">To</span>
          <input type="date" value={to} min={from || undefined} max={localDate()} onChange={(e) => reset(setTo)(e.target.value)} className={field} aria-invalid={badRange || undefined} />
        </label>
        <select aria-label="Status" value={status} onChange={(e) => reset(setStatus)(e.target.value)} className={`${field} col-span-2 sm:col-span-1`}>
          <option value="">Any status</option><option value="order">Order placed</option><option value="followup">Follow-up pending</option><option value="visited">Visited</option>
        </select>
      </div>
      {badRange && <p role="alert" className="-mt-2 text-xs text-red-600">The From date must not be after the To date.</p>}
      {(from || to) && (
        <button type="button" onClick={() => { setFrom(''); setTo(''); setPage(1) }} className="-mt-2 self-start text-xs font-medium text-primary hover:underline">Clear dates</button>
      )}

      {loading && !data && <p role="status" className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">Could not load visits. Please refresh.</p>}
      {data && data.results.length === 0 && (
        <Card>
          <EmptyState title={filtered ? 'No visits match these filters' : 'No visits yet'}
            hint={filtered ? undefined : 'Visits you record show up here.'}
            action={filtered ? undefined : <Link to="/record-visit" className="text-sm font-medium text-primary hover:underline">Record your first visit</Link>} />
        </Card>
      )}
      <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
        {data?.results.map((v) => {
          const st = visitStatus(v.status)
          return (
            <li key={v.id}>
              <Link to={`/visit-history/${v.id}`} className="block rounded-xl border bg-white p-4 shadow-card transition-colors hover:border-slate-300">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{v.dealer.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                      {v.dealer.city && <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden />{v.dealer.city}</span>}
                      <span>{fmtDate(v.visited_at, true)}, {fmtTime(v.visited_at)}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {v.source === 'whatsapp' && <Badge tone="gray">WhatsApp</Badge>}
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <ChevronRight size={16} className="text-slate-300" aria-hidden />
                  </div>
                </div>
                {v.has_order && (
                  <p className="mt-3 flex items-start gap-2 text-sm text-slate-700">
                    <Package size={15} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0">
                      {v.order_preview.map((i) => `${i.name} × ${i.quantity}`).join(', ')}{v.items > v.order_preview.length && ` +${v.items - v.order_preview.length} more`}
                      <span className="ml-2 text-xs text-slate-500">– {v.salesman}</span>
                      {v.order_total > 0 && <strong className="ml-2 tabular-nums text-slate-900">{fmtInr(v.order_total)}</strong>}
                    </span>
                  </p>
                )}
                {v.notes && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{v.notes}</p>}
                {v.followup_due && <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><CalendarClock size={13} aria-hidden />Follow-up {fmtDue(v.followup_due, v.followup_due_time)}</p>}
              </Link>
            </li>
          )
        })}
      </ul>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </div>
  )
}
