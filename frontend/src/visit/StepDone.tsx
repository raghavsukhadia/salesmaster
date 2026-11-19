import { Link } from 'react-router-dom'
import { CalendarClock, CheckCircle2, ClipboardPlus, Eye, History, Phone } from 'lucide-react'
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
  followups: { id: number; due_date: string; due_time: string | null; priority: string; task: string; state: string }[]
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
            {v.notes && <div className="sm:col-span-2"><dt className="text-xs font-medium text-slate-500">Notes</dt><dd className="mt-0.5 whitespace-pre-wrap text-slate-900">{v.notes}</dd></div>}
          </dl>

          <div className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Order</h3>
            {v.order_items.length === 0 ? <p className="mt-1 text-sm text-slate-500">No order on this visit.</p> : (
              // A list, not a table: four columns do not fit a phone. Each line is the item and what was ordered; a price line appears only when one was entered.
              <ul className="mt-2 divide-y text-sm">
                {v.order_items.map((i, n) => (
                  <li key={n} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0 break-words text-slate-900">{i.name}</span>
                    <span className="shrink-0 text-right tabular-nums text-slate-700">
                      {i.quantity} {i.unit}
                      {i.unit_price > 0 && <span className="block text-xs text-slate-500">{fmtInr(i.unit_price)} each · <span className="font-medium text-slate-900">{fmtInr(i.line_total)}</span></span>}
                    </span>
                  </li>
                ))}
                {v.order_total > 0 && (
                  <li className="flex items-center justify-between gap-3 py-2 font-medium">
                    <span className="text-slate-700">Order total</span>
                    <strong className="tabular-nums text-slate-900" data-testid="saved-total">{fmtInr(v.order_total)}</strong>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Follow-up</h3>
            {v.followups.length === 0 ? <p className="mt-1 text-sm text-slate-500">No follow-up scheduled.</p> : (
              <ul className="mt-2 space-y-1">
                {v.followups.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 text-sm text-slate-900">
                    <CalendarClock size={15} className="text-primary" aria-hidden />{f.task && <strong className="font-medium">{f.task} ·</strong>}{fmtDue(f.due_date, f.due_time)}<span className="text-xs capitalize text-slate-500">· {f.priority} priority</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {/* Phone: "Record another visit" full width on top, the two links side by side under it. From 640px: one row, primary on the right. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
        <Link to="/visit-history" className={buttonClass('secondary', 'md', 'w-full sm:w-auto')}><History size={16} aria-hidden />Visit history</Link>
        <Link to={`/visit-history/${saved.visit_id}`} className={buttonClass('secondary', 'md', 'w-full sm:w-auto')}><Eye size={16} aria-hidden />View visit</Link>
        <Button className="col-span-2 max-sm:order-first sm:col-auto" onClick={onAnother}><ClipboardPlus size={16} aria-hidden />Record another visit</Button>
      </div>
    </div>
  )
}
