import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, type Me } from '../../auth'
import { errText, field, Label, ModePills, AdminNotice, PreviewBox, EMPTY_SCOPE, ScopeFields, scopeBody, scopeReady, type Options, type Scope } from '../../components/ScopeFields'
import { PageHeader, useApi } from '../../components/ui'

interface Preview { dealers: number; open_followups: number; past_orders: number; territories: string[]; new_owner: string; sample: { id: number; name: string; city: string; state: string }[] }

function OwnerStatePicker({ owner, value, onChange }: { owner: string; value: string; onChange: (state: string) => void }) {
  const { data, loading, error, reload } = useApi<{ areas: { state: string; dealers: number; orders: number }[] }>(`/api/management/areas/?owner_id=${owner}`)
  return <div><Label text="State / area">
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading || error} className={field}>
      <option value="">{loading ? 'Loading areas...' : error ? 'Could not load areas' : data?.areas.length ? 'Select an assigned state' : 'No states with dealers assigned'}</option>
      {data?.areas.map((a) => <option key={a.state} value={a.state}>{a.state} ({a.dealers} dealers, {a.orders} past orders)</option>)}
    </select>
  </Label>
    {error && <button type="button" onClick={reload} className="mt-2 text-left text-xs text-red-700 underline">Could not load assigned states. Retry</button>}
  </div>
}

export default function TransferDealers() {
  const { me } = useOutletContext<{ me: Me }>()
  const admin = me.role === 'admin'
  const { data: options, error: optErr } = useApi<Options>('/api/management/scope-options/')
  const [scope, setScope] = useState<Scope>(EMPTY_SCOPE)
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('manual')
  const [reassign, setReassign] = useState(true)
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const body = { ...scopeBody(scope), to_salesman_id: to ? Number(to) : undefined, reason, reassign_followups: reassign }
  const key = JSON.stringify(body)
  const ready = scopeReady(scope) && !!to && (scope.mode === 'dealer' || scope.owner !== to)
  const shown = preview?.key === key ? preview.data : null // any edit invalidates the preview

  async function run(kind: 'preview' | 'execute') {
    if (busy) return
    setBusy(true)
    setErr('')
    setDone('')
    try {
      if (kind === 'preview') {
        setPreview({ key, data: await api<Preview>('/api/management/transfers/preview/', { method: 'POST', body }) })
      } else {
        const r = await api<{ transferred: number; followups_reassigned: number }>('/api/management/transfers/', { method: 'POST', body })
        setDone(`Transferred ${r.transferred} dealer${r.transferred === 1 ? '' : 's'}${r.followups_reassigned ? ` and reassigned ${r.followups_reassigned} open follow-up${r.followups_reassigned === 1 ? '' : 's'}` : ''}.`)
        setPreview(null)
        setScope({ ...EMPTY_SCOPE, mode: scope.mode })
        setTo('')
      }
    } catch (x) {
      setErr(errText(x))
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const change = (s: Scope) => { setScope(s); setDone('') }

  return (
    <>
      <PageHeader title="Transfer Area" subtitle="Hand a salesman's state, city or dealer to another salesman, with all existing dealer and order history." />
      <div className="rounded-2xl border p-6">
        <p role="note" className="mb-5 rounded-lg border bg-slate-50 p-3 text-sm text-slate-600">Existing orders keep their original salesman and stay read-only. The new salesman can see the transferred dealers and their complete order history in My Dealers. Future orders show the salesman who creates them.</p>
        {!admin && <AdminNotice />}
        {optErr && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">Could not load options. Please refresh.</p>}
        {done && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{done}</p>}
        {err && <p role="alert" className="mb-4 whitespace-normal rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <fieldset disabled={!admin || busy}>
          <ModePills value={scope.mode} onChange={(mode) => change({ ...EMPTY_SCOPE, mode })} />
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
            {scope.mode === 'owner_state' ? <>
              <Label text="Current salesman">
                <select value={scope.owner} onChange={(e) => { change({ ...scope, owner: e.target.value, state: '' }); if (to === e.target.value) setTo('') }} className={field}>
                  <option value="">Select the current salesman</option>
                  {options?.salesmen.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}
                </select>
              </Label>
              {scope.owner ? <OwnerStatePicker key={scope.owner} owner={scope.owner} value={scope.state} onChange={(state) => change({ ...scope, state })} /> : <Label text="State / area"><select disabled className={field}><option>Select a salesman first</option></select></Label>}
            </> : <ScopeFields scope={scope} onChange={change} options={options} ownerLabel="Current salesman" />}
            <Label text="New salesman">
              <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
                <option value="">Select a salesman</option>
                {options?.salesmen.filter((s) => s.active && (scope.mode === 'dealer' || String(s.id) !== scope.owner)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Label>
            <Label text="Reason">
              <select value={reason} onChange={(e) => setReason(e.target.value)} className={field}>
                {(options?.reasons ?? [{ value: 'manual', label: 'Manual transfer' }]).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Label>
          </div>
          <label className="mt-5 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={reassign} onChange={(e) => setReassign(e.target.checked)} className="h-4 w-4 accent-primary" />
            Reassign open follow-ups on transferred dealers to the new owner
          </label>
          {shown && (
            <><PreviewBox dealers={shown.dealers} sample={shown.sample}
              extra={<> will move to <b>{shown.new_owner}</b>{reassign && shown.open_followups > 0 ? `; ${shown.open_followups} open follow-up${shown.open_followups === 1 ? '' : 's'} will move too` : ''}.</>} />
              <p className="mt-3 text-sm text-slate-600">{shown.past_orders} existing order{shown.past_orders === 1 ? '' : 's'} will remain attributed to the original salesman.{shown.territories.length > 0 && ` Assigned areas moving: ${shown.territories.join(', ')}.`}</p></>
          )}
          <div className="mt-5 flex gap-2">
            {shown ? (
              <>
                <button type="button" onClick={() => run('execute')} disabled={shown.dealers === 0 || busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Transferring…' : `Confirm transfer of ${shown.dealers}`}</button>
                <button type="button" onClick={() => setPreview(null)} className="rounded-lg border px-4 py-2 text-sm font-medium">Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => run('preview')} disabled={!ready || busy} className="rounded-lg bg-primary hover:bg-primary-hover px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{busy ? 'Checking…' : 'Preview'}</button>
            )}
          </div>
        </fieldset>
      </div>
    </>
  )
}
