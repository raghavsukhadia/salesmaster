import { Link } from 'react-router-dom'
import { ArrowRight, ExternalLink, Eye, MapPin } from 'lucide-react'
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

export default function RecentVisits({ rows, loading, error, onRetry, rangeLabel }: { rows: VisitRow[]; loading: boolean; error: boolean; onRetry: () => void; rangeLabel: string }) {
  return (
    <Table loading={loading} error={error} onRetry={onRetry} empty={rows.length === 0}
      emptyTitle="No visits in this period" emptyHint={`Nothing was recorded for “${rangeLabel}”. Pick a wider date range in the top bar.`}
      head={[{ label: 'Dealer' }, { label: 'Salesman' }, { label: 'Date & time' }, { label: 'Check-in location' }, { label: 'Outcome' }, { label: 'Next follow-up' }, { label: 'Details', right: true }]}>
      {rows.map((v) => (
        <tr key={v.id}>
          <td><div className="font-medium text-slate-900">{v.dealer}</div><div className="text-xs text-slate-500">{v.phone || '—'}</div></td>
          <td className="whitespace-nowrap text-slate-700">{v.salesman}</td>
          <td className="whitespace-nowrap"><div className="text-slate-900">{fmtDate(v.visited_at)}</div><div className="text-xs text-slate-500">{fmtTime(v.visited_at)}</div></td>
          <td><CheckIn v={v} /></td>
          <td>
            {v.has_order ? <Badge tone="green">Order placed</Badge> : <Badge tone="gray">No order</Badge>}
            {v.products.length > 0 && <div className="mt-1 max-w-[12rem] truncate text-xs text-slate-500" title={v.products.join(', ')}>{v.products.join(', ')}</div>}
          </td>
          <td className="whitespace-nowrap">
            {v.followup_due ? <span className={v.followup_due < today() ? 'font-medium text-red-700' : 'text-slate-700'}>{fmtDate(v.followup_due, true)}{v.followup_due < today() && <span className="ml-1 text-xs">(overdue)</span>}</span> : <span className="text-slate-400">None set</span>}
          </td>
          <td className="text-right"><Link to={`/visits/${v.id}`} aria-label={`View visit to ${v.dealer}`} className={buttonClass('secondary', 'sm')}><Eye size={14} aria-hidden />View</Link></td>
        </tr>
      ))}
    </Table>
  )
}

export function ViewAll({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{children}<ArrowRight size={14} aria-hidden /></Link>
}
