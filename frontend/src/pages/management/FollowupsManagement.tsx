import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, fmtDate, PageHeader, Pager, Pills, qs, SearchBox, Select, StatStrip, Table, useApi, useDebounced } from '../../components/ui'

interface Row { id: number; due_date: string; salesman: string; dealer: string; location: string; title: string; priority: string; outcome: string; state: string }
interface Data { summary: { overdue: number; due_today: number; upcoming: number; completed: number; no_response: number }; count: number; results: Row[] }

const TONE: Record<string, ['red' | 'blue' | 'gray' | 'green', string]> = {
  overdue: ['red', 'Overdue'], due_today: ['blue', 'Due Today'], upcoming: ['gray', 'Upcoming'], completed: ['green', 'Completed'], cancelled: ['gray', 'Cancelled'],
}
const OUTCOME: Record<string, string> = { interested: 'Interested', call_again: 'Call again', send_quotation: 'Send quotation', no_answer: 'No answer', not_interested: 'Not interested' }

export default function FollowupsManagement() {
  const [params] = useSearchParams()
  const [tab, setTab] = useState(params.get('tab') ?? 'all')
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [sort, setSort] = useState('soon')
  const [page, setPage] = useState(1)
  const { data, loading, error } = useApi<Data>(`/api/management/followups/?${qs({ tab, q: dq, sort, page })}`)
  const s = data?.summary
  return (
    <>
      <PageHeader title="Follow-up Management" subtitle="Track salesman follow-up activity, outcomes and pending actions" action={<button disabled className="rounded-xl border px-4 py-2.5 text-sm opacity-50">Export</button>} />
      <StatStrip items={[
        { label: 'Overdue', value: s?.overdue ?? '–', tone: 'red' }, { label: 'Due Today', value: s?.due_today ?? '–', tone: 'red' },
        { label: 'Upcoming', value: s?.upcoming ?? '–' }, { label: 'Completed', value: s?.completed ?? '–' }, { label: 'No Response', value: s?.no_response ?? '–' },
      ]} />
      <div className="mb-4"><Pills value={tab} onChange={(v) => { setTab(v); setPage(1) }} options={[['all', 'All'], ['overdue', 'Overdue'], ['due_today', 'Due Today'], ['upcoming', 'Upcoming'], ['completed', 'Completed']]} /></div>
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search dealer, salesman, phone or follow-up" />
      <div className="mb-5 flex justify-end"><Select value={sort} onChange={(v) => { setSort(v); setPage(1) }}><option value="soon">Due soon</option><option value="latest">Due latest</option></Select></div>
      <Table head={[{ label: 'Due' }, { label: 'Salesman' }, { label: 'Dealer' }, { label: 'Follow-up' }, { label: 'Priority' }, { label: 'Outcome' }, { label: 'Status' }, { label: 'Action' }]}
        loading={loading} error={error} empty={data?.results.length === 0}>
        {data?.results.map((f) => {
          const [tone, label] = TONE[f.state] ?? TONE.upcoming
          return (
            <tr key={f.id}>
              <td className={`px-3 py-3 font-medium ${f.state === 'overdue' ? 'text-red-700' : ''}`}>{fmtDate(f.due_date, true)}</td>
              <td className="px-3 font-semibold">{f.salesman}</td>
              <td className="px-3"><div className="font-semibold">{f.dealer}</div><div className="text-xs text-slate-500">{f.location}</div></td>
              <td className="px-3"><div>{f.title}</div>{f.state === 'overdue' && <div className="text-xs text-amber-800">Needs attention</div>}</td>
              <td className="px-3 capitalize text-slate-500">{f.priority}</td>
              <td className="px-3">{OUTCOME[f.outcome] ?? '—'}</td>
              <td className="px-3"><Badge tone={tone}>{label}</Badge></td>
              <td className="px-3"><Link to={`/followups-management/${f.id}`} className="text-primary hover:underline">View</Link></td>
            </tr>
          )
        })}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </>
  )
}
