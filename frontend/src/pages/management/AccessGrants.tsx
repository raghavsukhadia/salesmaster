import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, type Me } from '../../auth'
import { errText, field, Label, ModePills, AdminNotice, PreviewBox, EMPTY_SCOPE, ScopeFields, scopeBody, scopeReady, type Options, type Scope } from '../../components/ScopeFields'
import { Badge, PageHeader, Pager, Table, fmtDate, useApi, useConfirm } from '../../components/ui'

interface Preview { dealers: number; sample: { id: number; name: string; city: string; state: string }[] }
interface Grant { id: number; grantee: string; source_owner: string | null; scope: string; type: string; starts_on: string | null; ends_on: string | null; status: string; revocable: boolean }
interface List { results: Grant[]; count: number; page: number; pages: number }

const today = () => new Date().toISOString().slice(0, 10)
const STATUSES = ['active', 'scheduled', 'expired', 'revoked']

export default function AccessGrants() {
  const { me } = useOutletContext<{ me: Me }>()
  const admin = me.role === 'admin'
  const confirm = useConfirm()
  const { data: options } = useApi<Options>('/api/management/scope-options/')
  const [scope, setScope] = useState<Scope>(EMPTY_SCOPE)
  const [grantee, setGrantee] = useState('')
  const [type, setType] = useState('temporary')
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState('')
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const [status, setStatus] = useState('active')
  const [page, setPage] = useState(1)
  const [v, setV] = useState(0)
  const { data: list, loading, error } = useApi<List>(`/api/management/access-grants/?status=${status}&page=${page}&_=${v}`)

  const body = { ...scopeBody(scope), salesman_id: grantee ? Number(grantee) : undefined, access_type: type, starts_on: start || null, ends_on: end || null }
  const key = JSON.stringify(body)
  const ready = scopeReady(scope) && !!grantee && (type !== 'temporary' || !!end)
  const shown = preview?.key === key ? preview.data : null

  async function run(kind: 'preview' | 'create') {
    if (busy) return
    setBusy(true); setErr(''); setDone('')
    try {
      if (kind === 'preview') {
        setPreview({ key, data: await api<Preview>('/api/management/access-grants/preview/', { method: 'POST', body }) })
      } else {
        const r = await api<{ dealers: number }>('/api/management/access-grants/', { method: 'POST', body })
        setDone(`Access granted${r?.dealers != null ? ` for ${r.dealers} dealer${r.dealers === 1 ? '' : 's'}` : ''}.`)
        setPreview(null); setScope({ ...EMPTY_SCOPE, mode: scope.mode }); setGrantee(''); setEnd('')
        setV((n) => n + 1)
      }
    } catch (x) { setErr(errText(x)); setPreview(null) } finally { setBusy(false) }
  }

  async function revoke(g: Grant) {
    if (!(await confirm({ title: 'Revoke access?', message: `${g.grantee} will immediately lose access to ${g.scope}.`, confirmLabel: 'Revoke access', danger: true }))) return
    try { await api(`/api/management/access-grants/${g.id}/revoke/`, { method: 'POST' }); setV((n) => n + 1) } catch (x) { setErr(errText(x)) }
  }

  const tone = (s: string) => (s === 'active' ? 'green' : s === 'scheduled' ? 'blue' : 'gray')

  return (
    <>
      <PageHeader title="Dealer Access Grants" />
      <div className="rounded-2xl border p-6">
        {!admin && <AdminNotice />}
        <h2 className="mb-4 font-semibold">Give Dealer Access</h2>
        {done && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{done}</p>}
        {err && <p role="alert" className="mb-4 whitespace-normal rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <fieldset disabled={!admin || busy}>
          <ModePills value={scope.mode} onChange={(mode) => { setScope({ ...EMPTY_SCOPE, mode }); setDone('') }} />
          <div className="grid grid-cols-2 gap-x-4 gap-y-5">
            <ScopeFields scope={scope} onChange={(s) => { setScope(s); setDone('') }} options={options} ownerLabel="Source Owner" />
            <Label text="Receiving Salesman">
              <select value={grantee} onChange={(e) => setGrantee(e.target.value)} className={field}>
                <option value="">Select a salesman</option>
                {options?.salesmen.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Label>
            <Label text="Access Type">
              <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
                {(options?.access_types ?? [{ value: 'temporary', label: 'Temporary Coverage' }, { value: 'shared', label: 'Shared Access' }]).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Label>
            <Label text="Start Date"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={field} /></Label>
            <Label text={type === 'temporary' ? 'End Date' : 'End Date (optional)'}><input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} className={field} /></Label>
          </div>
          {shown && <PreviewBox dealers={shown.dealers} sample={shown.sample} extra={<> will become visible to the selected salesman.</>} />}
          <div className="mt-5 flex gap-2">
            {shown ? (
              <>
                <button type="button" onClick={() => run('create')} disabled={shown.dealers === 0} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Granting…' : 'Confirm access'}</button>
                <button type="button" onClick={() => setPreview(null)} className="rounded-lg border px-4 py-2 text-sm font-medium">Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => run('preview')} disabled={!ready} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{busy ? 'Checking…' : 'Preview'}</button>
            )}
          </div>
        </fieldset>
      </div>

      <div className="mt-6 rounded-2xl border p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Grants</h2>
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} className="rounded-lg border bg-white px-3 py-2 text-sm capitalize">
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">Could not load grants.</p>}
        {loading && !list && <p className="text-sm text-slate-500">Loading…</p>}
        {list && list.results.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No {status} grants.</p>}
        {list && list.results.length > 0 && (
          <Table head={['Grantee', 'Source Owner', 'Scope', 'Type', 'Starts', 'Expires', 'Status', 'Action'].map((label) => ({ label }))}>
            {list.results.map((g) => (
              <tr key={g.id} className="border-t">
                <td className="px-4 py-3 font-medium">{g.grantee}</td>
                <td className="px-4 py-3">{g.source_owner ?? '—'}</td>
                <td className="px-4 py-3">{g.scope}</td>
                <td className="px-4 py-3 capitalize">{g.type}</td>
                <td className="px-4 py-3">{g.starts_on ? fmtDate(g.starts_on) : '—'}</td>
                <td className="px-4 py-3">{g.ends_on ? fmtDate(g.ends_on) : 'No expiry'}</td>
                <td className="px-4 py-3"><Badge tone={tone(g.status)}>{g.status}</Badge></td>
                <td className="px-4 py-3 text-right">{admin && g.revocable && <button onClick={() => revoke(g)} className="text-red-600 hover:underline">Revoke</button>}</td>
              </tr>
            ))}
          </Table>
        )}
        {list && list.pages > 1 && <Pager page={page} count={list.count} onChange={setPage} />}
      </div>
    </>
  )
}
