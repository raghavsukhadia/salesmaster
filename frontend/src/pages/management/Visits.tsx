import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye } from 'lucide-react'
import { useDateRange } from '../../components/DateRange'
import { Badge, buttonClass, fmtDate, fmtTime, PageHeader, Pager, qs, SearchBox, Select, StatStrip, Table, useApi, useDebounced } from '../../components/ui'
import { CheckIn, type VisitRow } from './RecentVisits'

interface Data { summary: { visits: number; active_salesmen: number; new_dealers: number; orders: number; followups_due: number }; count: number; results: VisitRow[] }

export default function Visits() {
  // The date range is shared with the top bar (?range=), so links and refreshes keep it.
  const [range, , rangeLabel] = useDateRange()
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [sort, setSort] = useState('newest')
  const [pg, setPg] = useState({ range, page: 1 })
  const page = pg.range === range ? pg.page : 1
  const setPage = (p: number) => setPg({ range, page: p })
  const { data, loading, error, reload } = useApi<Data>(`/api/management/visits/?${qs({ range, q: dq, sort, page })}`)
  const s = data?.summary
  return (
    <>
      <PageHeader title="Visit activity" subtitle={`Monitor field visits across all salesman · ${rangeLabel}`} />
      <StatStrip items={[
        { label: 'Visits', value: s?.visits ?? '–' }, { label: 'Active salesman', value: s?.active_salesmen ?? '–' },
        { label: 'New dealers', value: s?.new_dealers ?? '–' }, { label: 'Orders', value: s?.orders ?? '–' }, { label: 'Follow-ups due', value: s?.followups_due ?? '–' },
      ]} />
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search dealer, salesman, phone, city or product" />
      <div className="mb-5 flex justify-end">
        <Select value={sort} onChange={(v) => { setSort(v); setPage(1) }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></Select>
      </div>
      <Table stack head={[{ label: 'Date & time' }, { label: 'Salesman' }, { label: 'Dealer' }, { label: 'Check-in location' }, { label: 'Products' }, { label: 'Outcome' }, { label: 'Follow-up' }, { label: 'Details', right: true }]}
        loading={loading && !data} error={error && !data} onRetry={reload} empty={data?.results.length === 0}
        emptyTitle="No visits found" emptyHint={dq ? 'No visit matches your search in this period.' : `No visits were recorded for “${rangeLabel}”.`}>
        {data?.results.map((v) => (
          <tr key={v.id}>
            <td className="sm:whitespace-nowrap"><div className="font-medium text-slate-900">{fmtDate(v.visited_at)}</div><div className="text-xs text-slate-500">{fmtTime(v.visited_at)}</div></td>
            <td className="font-medium text-slate-900 sm:whitespace-nowrap">{v.salesman}</td>
            <td><div className="font-medium text-slate-900">{v.dealer}</div><div className="text-xs text-slate-500">{v.phone}</div></td>
            <td><CheckIn v={v} /></td>
            <td className="text-slate-600 sm:max-w-[14rem] sm:truncate" title={v.products.join(', ')}>{v.products.length ? v.products.join(', ') : '—'}</td>
            <td>{v.has_order ? <Badge tone="green">Order placed</Badge> : <Badge tone="gray">No order</Badge>}</td>
            <td className="text-slate-700 sm:whitespace-nowrap">{fmtDate(v.followup_due, true)}</td>
            <td className="text-right" data-label=""><Link to={`/visits/${v.id}`} aria-label={`View visit to ${v.dealer}`} className={buttonClass('secondary', 'sm', 'max-sm:h-10 max-sm:w-full')}><Eye size={14} aria-hidden />View</Link></td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </>
  )
}
