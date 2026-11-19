import { Link } from 'react-router-dom'
import { ArrowRight, CalendarClock, Clock, ExternalLink, Eye, MapPin } from 'lucide-react'
import { Badge, buttonClass, fmtDate, fmtTime, Table } from '../../components/ui'

export interface VisitRow {
  id: number; visited_at: string; salesman: string; dealer: string; phone: string; location: string
  checkin: { lat: number; lng: number; source: string } | null
  products: string[]; has_order: boolean; followup_due: string | null
}

const today = () => new Date().toLocaleDateString('en-CA')

/** The GPS fix the salesman's phone gave when the visit was recorded. Shown as coordinates: nothing is reverse-geocoded or guessed. */
export function CheckIn({ v }: { v: Pick<VisitRow, 'checkin' | 'location'> }) {
  return (
    <div className="min-w-0">
      {v.checkin ? (
        <a href={`https://www.google.com/maps?q=${v.checkin.lat},${v.checkin.lng}`} target="_blank" rel="noopener noreferrer"
          aria-label={`Open GPS check-in ${v.checkin.lat.toFixed(4)}, ${v.checkin.lng.toFixed(4)} in Google Maps (new tab)`}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <MapPin size={14} aria-hidden />{v.checkin.lat.toFixed(4)}, {v.checkin.lng.toFixed(4)}<ExternalLink size={11} aria-hidden />
        </a>
      ) : <span className="text-slate-500">No GPS captured</span>}
      {v.location && <div className="truncate text-xs text-slate-500">Dealer: {v.location}</div>}
    </div>
  )
}

/** Phone layout: one highlighted card per visit. The coloured edge says the outcome at a glance; empty points are left out. */
function VisitCard({ v }: { v: VisitRow }) {
  const overdue = !!v.followup_due && v.followup_due < today()
  return (
    <li className={`relative overflow-hidden rounded-2xl border bg-white shadow-card transition-shadow active:shadow-none ${v.has_order ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-primary'}`}>
      <Link to={`/visits/${v.id}`} aria-label={`View visit to ${v.dealer}`} className="block p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-slate-900">{v.dealer}</p>
            {v.phone && <p className="text-xs font-medium text-slate-500">{v.phone}</p>}
          </div>
          {v.has_order ? <Badge tone="green">Order placed</Badge> : <Badge tone="gray">No order</Badge>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 font-medium text-primary">
            <span className="grid size-4 place-items-center rounded-full bg-primary text-[9px] font-bold text-white">{v.salesman.trim().charAt(0).toUpperCase()}</span>{v.salesman}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700"><Clock size={12} aria-hidden />{fmtDate(v.visited_at)} · {fmtTime(v.visited_at)}</span>
        </div>

        {v.products.length > 0 && <p className="mt-3 truncate text-sm text-slate-700"><span className="text-slate-500">Items: </span>{v.products.join(', ')}</p>}
        {(v.checkin || v.location) && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-600">
            <MapPin size={14} className="shrink-0 text-primary" aria-hidden />
            <span className="truncate">{v.location || `${v.checkin!.lat.toFixed(4)}, ${v.checkin!.lng.toFixed(4)}`}{v.checkin && <span className="text-xs text-green-700"> · GPS ✓</span>}</span>
          </p>
        )}
        {v.followup_due && (
          <p className={`mt-2 flex items-center gap-1.5 text-sm ${overdue ? 'font-medium text-red-700' : 'text-slate-600'}`}>
            <CalendarClock size={14} className="shrink-0" aria-hidden />Follow-up {fmtDate(v.followup_due, true)}{overdue && ' (overdue)'}
          </p>
        )}

        <span className="mt-3 flex items-center justify-end gap-1 text-sm font-medium text-primary">View details<ArrowRight size={14} aria-hidden /></span>
      </Link>
    </li>
  )
}

export default function RecentVisits({ rows, loading, error, onRetry, rangeLabel }: { rows: VisitRow[]; loading: boolean; error: boolean; onRetry: () => void; rangeLabel: string }) {
  const cards = !loading && !error && rows.length > 0
  return (
    <>
      {cards && <ul className="space-y-3 sm:hidden" aria-label="Recent visits">{rows.map((v) => <VisitCard key={v.id} v={v} />)}</ul>}
      <div className={cards ? 'hidden sm:block' : ''}>
    <Table stack loading={loading} error={error} onRetry={onRetry} empty={rows.length === 0}
      emptyTitle="No visits in this period" emptyHint={`Nothing was recorded for “${rangeLabel}”. Pick a wider date range in the top bar.`}
      head={[{ label: 'Dealer' }, { label: 'Salesman' }, { label: 'Date & time' }, { label: 'Check-in location' }, { label: 'Outcome' }, { label: 'Next follow-up' }, { label: 'Details', right: true }]}>
      {rows.map((v) => (
        <tr key={v.id}>
          <td><div className="font-medium text-slate-900">{v.dealer}</div><div className="text-xs text-slate-500">{v.phone || '—'}</div></td>
          <td className="text-slate-700 sm:whitespace-nowrap">{v.salesman}</td>
          <td className="sm:whitespace-nowrap"><div className="text-slate-900">{fmtDate(v.visited_at)}</div><div className="text-xs text-slate-500">{fmtTime(v.visited_at)}</div></td>
          <td><CheckIn v={v} /></td>
          <td>
            {v.has_order ? <Badge tone="green">Order placed</Badge> : <Badge tone="gray">No order</Badge>}
            {v.products.length > 0 && <div className="mt-1 text-xs text-slate-500 sm:max-w-[12rem] sm:truncate" title={v.products.join(', ')}>{v.products.join(', ')}</div>}
          </td>
          <td className="sm:whitespace-nowrap">
            {v.followup_due ? <span className={v.followup_due < today() ? 'font-medium text-red-700' : 'text-slate-700'}>{fmtDate(v.followup_due, true)}{v.followup_due < today() && <span className="ml-1 text-xs">(overdue)</span>}</span> : <span className="text-slate-400">None set</span>}
          </td>
          <td className="text-right" data-label=""><Link to={`/visits/${v.id}`} aria-label={`View visit to ${v.dealer}`} className={buttonClass('secondary', 'sm', 'max-sm:h-10 max-sm:w-full')}><Eye size={14} aria-hidden />View</Link></td>
        </tr>
      ))}
    </Table>
      </div>
    </>
  )
}

export function ViewAll({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{children}<ArrowRight size={14} aria-hidden /></Link>
}
