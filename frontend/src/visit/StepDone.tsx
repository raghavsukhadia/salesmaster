import { Link } from 'react-router-dom'
import { CalendarClock, CheckCircle2, ClipboardPlus, Eye, History, MapPin, Phone } from 'lucide-react'
import { Badge, Button, buttonClass, Card, ErrorState, fmtDate, fmtTime, Skeleton, useApi } from '../components/ui'
import { fmtDue, visitStatus } from './format.ts'
import { fmtInr } from './orderMath.ts'
import type { Saved } from './StepOrder'

interface Detail {
  id: number
  visited_at: string
  notes: string
  status: string
  dealer: { id: number; name: string; phone: string; city: string; state: string; shop_name: string }
  location: { lat: number | null; lng: number | null }
  order_items: { name: string; quantity: number; unit: string; unit_price: number; line_total: number }[]
  order_total: number
  followups: { id: number; due_date: string; due_time: string | null; priority: string; state: string }[]
}

/**
 * Step 3. Everything below the banner is read back from the server, so it is the record that was actually saved,
 * not an echo of what was typed. The visit is saved either way: if the read-back fails the banner still stands.
 */
export default function StepDone({ saved, newDealer, onAnother }: { saved: Saved; newDealer: boolean; onAnother: () => void }) {
  const { data: v, loading, error, reload } = useApi<Detail>(`/api/salesman/visits/${saved.visit_id}/`)
  const status = v ? visitStatus(v.status) : null

  return (
    <div className="space-y-5">
      <Card className="flex flex-col items-center px-6 py-8 text-center" role="status">
        <span className="grid size-14 place-items-center rounded-full bg-green-50 text-green-600"><CheckCircle2 size={34} aria-hidden /></span>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">{saved.created ? 'Visit recorded' : 'This visit was already recorded'}</h2>
        <p className="mt-1 max-w-md text-sm text-slate-500">
          {saved.created ? 'Your visit has been saved. You can find it in Visit History.' : 'You submitted this visit before, so nothing new was created.'}
        </p>
      </Card>

      {loading && !v && <Card className="space-y-3 p-5" aria-hidden><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-40" /></Card>}
      {error && !v && <Card><ErrorState message="The visit is saved, but its details could not be loaded." onRetry={reload} /></Card>}

      {v && status && (
        <Card className="divide-y">
          <div className="flex flex-wrap items-start justify-between gap-3 p-5">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-lg font-semibold text-slate-900">
                <span className="truncate">{v.dealer.name}</span>
                {newDealer && <Badge tone="orange">New dealer added</Badge>}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                {v.dealer.city && <span>{[v.dealer.city, v.dealer.state].filter(Boolean).join(', ')}</span>}
                {v.dealer.phone && <span className="inline-flex items-center gap-1"><Phone size={13} aria-hidden />{v.dealer.phone}</span>}
              </p>
            </div>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>

          <dl className="grid gap-4 p-5 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-medium text-slate-500">Visited</dt><dd className="mt-0.5 text-slate-900">{fmtDate(v.visited_at)}, {fmtTime(v.visited_at)}</dd></div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Location</dt>
              <dd className="mt-0.5 text-slate-900">
                {v.location.lat != null ? <span className="inline-flex items-center gap-1"><MapPin size={14} aria-hidden />Captured ({v.location.lat.toFixed(4)}, {v.location.lng?.toFixed(4)})</span> : 'Not captured'}
              </dd>
            </div>
            {v.notes && <div className="sm:col-span-2"><dt className="text-xs font-medium text-slate-500">Notes</dt><dd className="mt-0.5 whitespace-pre-wrap text-slate-900">{v.notes}</dd></div>}
          </dl>

          <div className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Order</h3>
            {v.order_items.length === 0 ? <p className="mt-1 text-sm text-slate-500">No order on this visit.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-sm">
                  <thead className="text-xs text-slate-500"><tr><th className="py-1 pr-3 font-medium">Item</th><th className="px-3 py-1 text-right font-medium">Qty</th><th className="px-3 py-1 text-right font-medium">Price</th><th className="py-1 pl-3 text-right font-medium">Total</th></tr></thead>
                  <tbody className="divide-y">
                    {v.order_items.map((i, n) => (
                      <tr key={n}>
                        <td className="py-2 pr-3 text-slate-900">{i.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.quantity} {i.unit}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.unit_price ? fmtInr(i.unit_price) : '—'}</td>
                        <td className="py-2 pl-3 text-right tabular-nums">{i.unit_price ? fmtInr(i.line_total) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  {v.order_total > 0 && <tfoot><tr className="border-t"><th colSpan={3} className="py-2 pr-3 text-right font-medium text-slate-700">Order total</th><td className="py-2 pl-3 text-right font-semibold tabular-nums text-slate-900" data-testid="saved-total">{fmtInr(v.order_total)}</td></tr></tfoot>}
                </table>
              </div>
            )}
          </div>

          <div className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Follow-up</h3>
            {v.followups.length === 0 ? <p className="mt-1 text-sm text-slate-500">No follow-up scheduled.</p> : (
              <ul className="mt-2 space-y-1">
                {v.followups.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 text-sm text-slate-900">
                    <CalendarClock size={15} className="text-primary" aria-hidden />{fmtDue(f.due_date, f.due_time)}<span className="text-xs capitalize text-slate-500">· {f.priority} priority</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link to="/visit-history" className={buttonClass('secondary')}><History size={16} aria-hidden />Visit history</Link>
        <Link to={`/visit-history/${saved.visit_id}`} className={buttonClass('secondary')}><Eye size={16} aria-hidden />View visit</Link>
        <Button onClick={onAnother}><ClipboardPlus size={16} aria-hidden />Record another visit</Button>
      </div>
    </div>
  )
}
