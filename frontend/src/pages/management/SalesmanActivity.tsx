import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Search, UserPlus, Users, X } from 'lucide-react'
import { Badge, buttonClass, Card, EmptyState, fmtDate, fmtRelative, fmtTime, Pager, Select, Table } from '../../components/ui'

export interface ActivityRow {
  id: number; name: string; visits_today: number; new_dealers: number; orders: number; followups_due: number; last_visit_at: string | null
}
type Key = 'name' | 'status' | 'visits' | 'new' | 'orders' | 'due' | 'last'
const SIZE = 10

const value: Record<Key, (r: ActivityRow) => number | string> = {
  name: (r) => r.name.toLowerCase(),
  status: (r) => (r.visits_today > 0 ? 1 : 0),
  visits: (r) => r.visits_today,
  new: (r) => r.new_dealers,
  orders: (r) => r.orders,
  due: (r) => r.followups_due,
  last: (r) => (r.last_visit_at ? new Date(r.last_visit_at).getTime() : 0),
}

/**
 * Status comes from what is recorded: a salesman with a visit logged today is "Active today". There is no
 * live presence signal in this table, so it never says "online".
 */
export default function SalesmanActivity({ rows, loading, error, onRetry, canAdd }: { rows: ActivityRow[]; loading: boolean; error: boolean; onRetry: () => void; canAdd: boolean }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState<{ key: Key; dir: 'asc' | 'desc' }>({ key: 'visits', dir: 'desc' })
  const [page, setPage] = useState(1)

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = rows.filter((r) => (!n || r.name.toLowerCase().includes(n)) && (status === 'all' || (status === 'active') === r.visits_today > 0))
    const get = value[sort.key]
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const x = get(a), y = get(b)
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * (x === y ? 1 : sign)
    })
  }, [rows, q, status, sort])

  const pages = Math.max(1, Math.ceil(shown.length / SIZE))
  const current = Math.min(page, pages)
  const pageRows = shown.slice((current - 1) * SIZE, current * SIZE)
  const filtered = q.trim() !== '' || status !== 'all'

  const head = (key: Key, label: string, right = false) => ({
    label, right,
    sorted: sort.key === key ? sort.dir : null,
    onSort: () => { setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }); setPage(1) },
  })
  const clear = () => { setQ(''); setStatus('all'); setPage(1) }

  return (
    <section aria-labelledby="activity-h">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="activity-h" className="text-lg font-semibold text-slate-900">Salesman activity</h2>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex h-10 w-full items-center gap-2 rounded-lg border bg-white px-3 focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15 sm:w-60">
            <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search salesman" aria-label="Search salesman"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:border-transparent focus-visible:shadow-none" />
            {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="rounded p-1 text-slate-400 hover:text-slate-700"><X size={14} aria-hidden /></button>}
          </div>
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1) }}>
            <option value="all">All statuses</option><option value="active">Active today</option><option value="idle">No visits today</option>
          </Select>
        </div>
      </div>

      {!loading && !error && rows.length === 0 ? (
        <Card><EmptyState icon={<Users size={20} aria-hidden />} title="No active salesmen yet" hint="Add a salesman to start tracking field activity."
          action={canAdd ? <Link to="/salesmen" className={buttonClass('primary', 'sm')}><UserPlus size={14} aria-hidden />Add a salesman</Link> : undefined} /></Card>
      ) : (
        <>
          <Table loading={loading} error={error} onRetry={onRetry} empty={shown.length === 0}
            emptyTitle="No salesmen match your filters" emptyHint={filtered ? 'Try a different name or status.' : undefined}
            head={[head('name', 'Salesman'), head('status', 'Status'), head('visits', 'Visits today'), head('new', 'New dealers'), head('orders', 'Orders'), head('due', 'Follow-ups due'), head('last', 'Last activity'), { label: 'Details', right: true }]}>
            {pageRows.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold uppercase text-primary">{s.name.slice(0, 2)}</span>
                    <Link to={`/salesmen/${s.id}`} className="font-medium text-slate-900 hover:text-primary hover:underline">{s.name}</Link>
                  </div>
                </td>
                <td>{s.visits_today > 0 ? <Badge tone="green">Active today</Badge> : <Badge tone="gray">No visits today</Badge>}</td>
                <td className="tabular-nums">{s.visits_today}</td>
                <td className="tabular-nums">{s.new_dealers}</td>
                <td className="tabular-nums">{s.orders}</td>
                <td className="tabular-nums">{s.followups_due > 0 ? <Badge tone="amber">{s.followups_due}</Badge> : <span className="text-slate-500">0</span>}</td>
                <td className="whitespace-nowrap text-slate-600">
                  {s.last_visit_at ? <time dateTime={s.last_visit_at} title={`${fmtDate(s.last_visit_at)}, ${fmtTime(s.last_visit_at)}`}>{fmtRelative(s.last_visit_at)}</time> : <span className="text-slate-400">No visits yet</span>}
                </td>
                <td className="text-right">
                  <Link to={`/salesmen/${s.id}`} aria-label={`View details for ${s.name}`} className={buttonClass('secondary', 'sm')}><Eye size={14} aria-hidden />View</Link>
                </td>
              </tr>
            ))}
          </Table>
          {!loading && !error && shown.length === 0 && filtered && (
            <div className="mt-3 text-center"><button type="button" onClick={clear} className="text-sm font-medium text-primary hover:underline">Clear filters</button></div>
          )}
          {!loading && !error && <Pager page={current} count={shown.length} size={SIZE} onChange={setPage} />}
        </>
      )}
    </section>
  )
}
