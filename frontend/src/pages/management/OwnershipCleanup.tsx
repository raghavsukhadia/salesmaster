import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, type Me } from '../../auth'
import { AdminNotice, errText, field, Label, type Options } from '../../components/ScopeFields'
import { Modal, PageHeader, Table, useApi } from '../../components/ui'

interface Group { state: string; city: string; count: number }
interface Cleanup { total: number; groups: Group[]; filters: { states: string[]; statuses: string[] } }

export default function OwnershipCleanup() {
  const { me } = useOutletContext<{ me: Me }>()
  const admin = me.role === 'admin'
  const { data: options } = useApi<Options>('/api/management/scope-options/')
  const [f, setF] = useState({ state: '', city: '', status: '', q: '' })
  const [applied, setApplied] = useState(f)
  const [v, setV] = useState(0)
  const query = new URLSearchParams(Object.entries(applied).filter(([, x]) => x)).toString()
  const { data, loading, error } = useApi<Cleanup>(`/api/management/ownership-cleanup/?${query}&_=${v}`)
  const [target, setTarget] = useState<Group | null>(null)
  const [sm, setSm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  async function assign() {
    if (!target || !sm || busy) return
    setBusy(true); setErr('')
    try {
      const r = await api<{ assigned: number }>('/api/management/ownership-cleanup/assign/', { method: 'POST', body: { salesman_id: Number(sm), state: target.state, city: target.city } })
      setDone(`Assigned ${r.assigned} dealer${r.assigned === 1 ? '' : 's'} in ${[target.city, target.state].filter(Boolean).join(', ') || 'selected group'}.`)
      setTarget(null); setSm(''); setV((n) => n + 1)
    } catch (x) { setErr(errText(x)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title="Dealer Ownership Cleanup" />
      {!admin && <AdminNotice />}
      {done && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{done}</p>}
      <form onSubmit={(e) => { e.preventDefault(); setApplied(f) }} className="mb-6 grid grid-cols-5 items-end gap-3 rounded-2xl border p-6">
        <Label text="State">
          <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} className={field}>
            <option value="">All states</option>
            {(data?.filters.states ?? options?.states ?? []).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Label>
        <Label text="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="Any city" className={field} /></Label>
        <Label text="Dealer status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={field}>
            <option value="">All statuses</option>
            {(data?.filters.statuses ?? []).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Label>
        <Label text="Search name"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Dealer name" className={field} /></Label>
        <button className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2.5 text-sm font-medium text-white">Apply filters</button>
      </form>

      <div className="rounded-2xl border p-6">
        <h2 className="mb-4 font-semibold">Unassigned Dealers{data ? ` (${data.total})` : ''}</h2>
        {error && <p role="alert" className="text-sm text-red-700">Could not load dealers.</p>}
        {loading && !data && <p className="text-sm text-slate-500">Loading…</p>}
        {data && data.groups.length === 0 && <p className="py-6 text-center text-sm text-slate-500">All dealers have an owner. Nothing to clean up.</p>}
        {data && data.groups.length > 0 && (
          <Table head={['State', 'City', 'Dealers', 'Action'].map((label) => ({ label }))}>
            {data.groups.map((g) => (
              <tr key={`${g.state}|${g.city}`} className="border-t">
                <td className="px-4 py-3">{g.state || '—'}</td>
                <td className="px-4 py-3">{g.city || '—'}</td>
                <td className="px-4 py-3 font-medium">{g.count}</td>
                <td className="px-4 py-3 text-right">{admin && <button onClick={() => { setTarget(g); setErr('') }} className="text-primary hover:underline">Assign</button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {target && (
        <Modal title={`Assign ${target.count} dealer${target.count === 1 ? '' : 's'}`} onClose={() => setTarget(null)}>
          <div>
            <p className="mb-4 text-sm text-slate-500">{[target.city, target.state].filter(Boolean).join(', ') || 'Selected group'}</p>
            {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
            <Label text="Salesman">
              <select value={sm} onChange={(e) => setSm(e.target.value)} className={field}>
                <option value="">Select a salesman</option>
                {options?.salesmen.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Label>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setTarget(null)} className="rounded-lg border px-4 py-2 text-sm font-medium">Cancel</button>
              <button onClick={assign} disabled={!sm || busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Assigning…' : 'Assign'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
