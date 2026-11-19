import { useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { ArrowRightLeft, FileUp, UserCheck, X } from 'lucide-react'
import { api, ApiError, type Me } from '../../auth'
import { Badge, Button, buttonClass, DropdownSelect, flatten, fmtDate, Modal, PageHeader, Pager, Pills, qs, SearchBox, Select, StatStrip, Table, useApi, useDebounced } from '../../components/ui'
import { INDIAN_STATES } from '../../states'

interface Row { id: number; name: string; phone: string; location: string; status: string; owner: string | null; last_visit_at: string | null; next_followup: string | null; access: number }
interface Data {
  summary: { total: number; owned: number; unassigned: number; active: number }
  filters: { states: string[]; statuses: string[]; owners: { id: number; name: string }[] }
  count: number
  results: Row[]
}

const DEALER_STATUSES = ['Prospect', 'New', 'Active', 'Inactive', 'Converted', 'Lost']
const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A–Z)' }, { value: 'name_desc', label: 'Name (Z–A)' },
  { value: 'recent', label: 'Last visit' }, { value: 'followup', label: 'Next follow-up' }, { value: 'newest', label: 'Newest' },
]

/** Move one dealer to another salesman. The new owner sees it in My Dealers straight away. */
function TransferModal({ dealer, onClose, onDone }: { dealer: Row; onClose: () => void; onDone: (msg: string) => void }) {
  const { data } = useApi<{ salesmen: { id: number; name: string; active: boolean }[] }>('/api/management/scope-options/')
  const [sid, setSid] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const options = (data?.salesmen ?? []).filter((s) => s.active && s.name !== dealer.owner)
  const to = options.find((s) => String(s.id) === sid)?.name

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!sid || busy) return
    setBusy(true); setErr('')
    try {
      await api(`/api/dealers/${dealer.id}/transfer/`, { method: 'POST', body: { salesman_id: Number(sid), reason } })
      onDone(`${dealer.name} ${dealer.owner ? 'transferred' : 'assigned'} to ${to}. It now shows in their My Dealers.`)
    } catch (x) {
      setErr(x instanceof ApiError ? flatten(x.data).join(' · ') || 'Transfer failed' : 'Network error. Please try again.')
      setBusy(false)
    }
  }

  return (
    <Modal title={dealer.owner ? 'Transfer dealer' : 'Assign dealer'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 whitespace-normal">
        <p className="text-sm text-slate-600"><b className="text-slate-900">{dealer.name}</b><br />Current owner: {dealer.owner ?? <span className="text-amber-800">Unassigned</span>}</p>
        <Select label={dealer.owner ? 'Transfer to' : 'Assign to'} value={sid} onChange={setSid}>
          <option value="">Select salesman</option>
          {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">Reason (optional)
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="h-10 rounded-lg border bg-white px-3 text-sm font-normal text-slate-900" />
        </label>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!sid}>{dealer.owner ? 'Transfer' : 'Assign'}</Button>
        </div>
      </form>
    </Modal>
  )
}

/** Remounts when the URL's filters change: dashboard cards and the global search link here with ?assignment= / ?visit= / ?q= / ?sort=. */
export default function Dealers() {
  const [params] = useSearchParams()
  return <DealersList key={params.toString()} />
}

function DealersList() {
  const { me } = useOutletContext<{ me: Me }>()
  const [params] = useSearchParams()
  const [assignment, setAssignment] = useState(params.get('assignment') ?? 'all')
  const [archive, setArchive] = useState('active')
  const [q, setQ] = useState(params.get('q') ?? '')
  const dq = useDebounced(q)
  const [state, setState] = useState('')
  const [city, setCity] = useState('')
  const dcity = useDebounced(city)
  const [status, setStatus] = useState('')
  const [owner, setOwner] = useState('')
  const [visit, setVisit] = useState(params.get('visit') === 'stale' ? 'stale' : '')
  const [sort, setSort] = useState(SORT_OPTIONS.find((o) => o.value === params.get('sort'))?.value ?? 'name')
  const [page, setPage] = useState(1)
  const [moving, setMoving] = useState<Row | null>(null)
  const [msg, setMsg] = useState('')
  const [n, setN] = useState(0) // bumped after a transfer so the list reloads
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1) }
  const admin = me.role === 'admin'

  const { data, loading, error } = useApi<Data>(`/api/management/dealers/?${qs({
    assignment: assignment === 'all' ? '' : assignment, archive, q: dq, state, city: dcity, status, owner, visit, sort, page })}&_=${n}`)
  const s = data?.summary
  // Full list of Indian states / UTs, plus any older free-text state already saved on a dealer
  // (the backend filter is case-insensitive, so compare the same way to avoid duplicates).
  const known = new Set(INDIAN_STATES.map((x) => x.toLowerCase()))
  const stateOptions = [
    { value: '', label: 'All states' },
    ...[...INDIAN_STATES, ...(data?.filters.states ?? []).filter((x) => !known.has(x.toLowerCase()))].map((x) => ({ value: x, label: x })),
  ]
  // Every dealer status, plus any custom status configured in the database that isn't in the standard set.
  const knownStatus = new Set(DEALER_STATUSES.map((x) => x.toLowerCase()))
  const statusOptions = [
    { value: '', label: 'All statuses' },
    ...[...DEALER_STATUSES, ...(data?.filters.statuses ?? []).filter((x) => !knownStatus.has(x.toLowerCase()))].map((x) => ({ value: x, label: x })),
  ]

  return (
    <>
      <PageHeader title="Dealers"
        action={admin ? <>
          <Link to="/dealers/import" className={buttonClass('soft')}><FileUp size={16} aria-hidden />Import</Link>
          <Link to="/dealers/transfer" className={buttonClass('primary')}><ArrowRightLeft size={16} aria-hidden />Transfer Area</Link>
          <Link to="/dealers/ownership-cleanup" className={buttonClass('secondary')}><UserCheck size={16} aria-hidden />Assign owners</Link>
        </> : undefined} />
      {msg && <p role="status" className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{msg}<button type="button" onClick={() => setMsg('')} aria-label="Dismiss"><X size={16} aria-hidden /></button></p>}
      <StatStrip items={[
        { label: 'Total Dealers', value: s?.total ?? '–' }, { label: 'Owned Dealers', value: s?.owned ?? '–' },
        { label: 'Unassigned Dealers', value: s?.unassigned ?? '–', tone: 'amber' }, { label: 'Active Dealers', value: s?.active ?? '–' },
      ]} />
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Pills value={assignment} onChange={reset(setAssignment)} options={[['all', 'All'], ['assigned', 'Assigned'], ['unassigned', 'Unassigned']]} />
        <span className="hidden h-6 border-l sm:block" />
        <Pills value={archive} onChange={reset(setArchive)} options={[['active', 'Active'], ['archived', 'Archived'], ['all', 'All']]} />
        {visit === 'stale' && (
          <button type="button" onClick={() => reset(setVisit)('')} aria-label="Remove filter: no visit in 30 days"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-orange-200 bg-accent-soft px-3 text-sm font-medium text-accent-ink hover:bg-orange-100">
            No visit in 30+ days<X size={14} aria-hidden />
          </button>
        )}
      </div>
      <SearchBox value={q} onChange={reset(setQ)} placeholder="Search dealer name, phone, city or state" />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <DropdownSelect label="State" value={state} onChange={reset(setState)} options={stateOptions} />
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">City<input value={city} onChange={(e) => reset(setCity)(e.target.value)} placeholder="e.g. Ahmedabad" className="h-10 rounded-lg border bg-white px-3 text-sm font-normal text-slate-900" /></label>
        <DropdownSelect label="Status" value={status} onChange={reset(setStatus)} options={statusOptions} />
        <Select label="Current Owner" value={owner} onChange={reset(setOwner)}><option value="">All owners</option>{data?.filters.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
        <DropdownSelect label="Sort" value={sort} onChange={reset(setSort)} options={SORT_OPTIONS} />
      </div>
      <Table stack head={[{ label: 'Dealer' }, { label: 'Location' }, { label: 'Status' }, { label: 'Current Owner' }, { label: 'Last Visit' }, { label: 'Next Follow-up' }, { label: 'Access' }, { label: 'Action' }]}
        loading={loading} error={error} empty={data?.results.length === 0}>
        {data?.results.map((d) => (
          <tr key={d.id}>
            <td className="px-3 py-3"><div className="font-semibold">{d.name}</div><div className="text-xs text-slate-500">{d.phone}</div></td>
            <td className="px-3 text-slate-600">{d.location || '—'}</td>
            <td className="px-3">{d.status ? <Badge>{d.status}</Badge> : '—'}</td>
            <td className="px-3 font-semibold">{d.owner ?? <span className="font-normal text-amber-800">Unassigned</span>}</td>
            <td className="px-3 text-slate-600">{fmtDate(d.last_visit_at, true)}</td>
            <td className="px-3 text-slate-600">{fmtDate(d.next_followup, true)}</td>
            <td className="px-3 text-slate-600">{d.access ? `${d.access} grant${d.access > 1 ? 's' : ''}` : 'None'}</td>
            <td className="px-3" data-label="">
              <div className="flex gap-2 max-sm:w-full">
                <Link to={`/dealers/${d.id}`} aria-label={`View ${d.name}`} className={buttonClass('soft', 'sm', 'max-sm:h-10 max-sm:flex-1')}>View</Link>
                {admin && (
                  <button type="button" onClick={() => setMoving(d)} aria-label={`${d.owner ? 'Transfer' : 'Assign'} ${d.name}`} className={buttonClass('primary', 'sm', 'max-sm:h-10 max-sm:flex-1')}>
                    <ArrowRightLeft size={14} aria-hidden />{d.owner ? 'Transfer' : 'Assign'}
                  </button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
      {moving && <TransferModal dealer={moving} onClose={() => setMoving(null)} onDone={(text) => { setMoving(null); setMsg(text); setN((v) => v + 1) }} />}
    </>
  )
}
