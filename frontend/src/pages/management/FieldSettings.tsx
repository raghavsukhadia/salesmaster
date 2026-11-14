import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, ApiError } from '../../auth'
import type { Me } from '../../auth'
import { Badge, Button, fmtDate, fmtTime, flatten, PageHeader, Pager, Select, Table, useApi } from '../../components/ui'

interface Config {
  default_geofence_m: number; geofence_mode: 'enforce' | 'flag'; ping_interval_s: number; retention_days: number
  updated_at: string; radii_km: number[]; live_max_age_s: number; stale_max_age_s: number
}
interface Audit { count: number; results: { id: number; at: string; actor: string; action: string; salesman: string | null; dealer_id: number | null; detail: Record<string, unknown> }[] }

const ACTIONS = ['session_start', 'session_end', 'session_force_end', 'map_view', 'track_view', 'reverse_search', 'dealer_location_set', 'dealer_location_verify', 'config_change', 'purge']

function Number_({ label, value, onChange, disabled, min, max }: { label: string; value: number; onChange: (n: number) => void; disabled: boolean; min: number; max: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input type="number" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-40 rounded-lg border px-3 py-2 disabled:bg-slate-50" />
    </label>
  )
}

function ConfigForm({ cfg, canEdit, onSaved }: { cfg: Config; canEdit: boolean; onSaved: () => void }) {
  const [v, setV] = useState({ default_geofence_m: cfg.default_geofence_m, geofence_mode: cfg.geofence_mode, ping_interval_s: cfg.ping_interval_s, retention_days: cfg.retention_days })
  const [msg, setMsg] = useState<{ ok: boolean; text: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true); setMsg(null)
    try { await api('/api/management/field/config/', { method: 'PUT', body: v }); setMsg({ ok: true, text: ['Saved.'] }); onSaved() }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? flatten(e.data) : ['Could not save.'] }) }
    finally { setBusy(false) }
  }
  return (
    <section className="mb-8 rounded-xl border bg-white p-5 shadow-card whitespace-normal" aria-labelledby="cfg-h">
      <h2 id="cfg-h" className="text-lg font-semibold">Tracking and geofence settings</h2>
      {!canEdit && <p className="mt-1 text-sm text-slate-500">Only an administrator can change these.</p>}
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <Number_ label="Default geofence radius (metres)" value={v.default_geofence_m} min={20} max={2000} disabled={!canEdit} onChange={(n) => setV({ ...v, default_geofence_m: n })} />
        <div className="flex flex-col gap-1 text-sm">
          <select aria-label="When a check-in is outside the geofence" value={v.geofence_mode} disabled={!canEdit} onChange={(e) => setV({ ...v, geofence_mode: e.target.value as 'enforce' | 'flag' })}
            className="rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 disabled:bg-slate-50">
            <option value="enforce">Block it</option>
            <option value="flag">Allow it, but flag it for review</option>
          </select>
        </div>
        <Number_ label="Location recording interval (seconds)" value={v.ping_interval_s} min={10} max={600} disabled={!canEdit} onChange={(n) => setV({ ...v, ping_interval_s: n })} />
        <Number_ label="Keep GPS points for (days)" value={v.retention_days} min={7} max={730} disabled={!canEdit} onChange={(n) => setV({ ...v, retention_days: n })} />
      </div>
      {canEdit && <div className="mt-4 flex items-center gap-3"><Button loading={busy} onClick={() => void save()}>Save settings</Button>
        {msg?.text.map((t) => <span key={t} role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{t}</span>)}</div>}
    </section>
  )
}

function AuditLog() {
  const [page, setPage] = useState(1)
  const [action, setAction] = useState('')
  const { data, loading, error } = useApi<Audit>(`/api/management/field/audit/?page=${page}${action ? `&action=${action}` : ''}`)
  return (
    <section aria-labelledby="audit-h" className="whitespace-normal">
      <div className="mb-3 flex items-end justify-between">
        <div><h2 id="audit-h" className="text-lg font-semibold">Audit log</h2><p className="text-sm text-slate-500">Who started, ended, viewed or changed location data.</p></div>
        <Select label="Action" value={action} onChange={(a) => { setAction(a); setPage(1) }}><option value="">All actions</option>{ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</Select>
      </div>
      <Table loading={loading} error={error} empty={data?.results.length === 0} head={[{ label: 'When' }, { label: 'Who' }, { label: 'Action' }, { label: 'About' }, { label: 'Details' }]}>
        {data?.results.map((a) => (
          <tr key={a.id} className="align-top">
            <td className="px-3 py-3 whitespace-nowrap text-slate-600">{fmtDate(a.at)} {fmtTime(a.at)}</td>
            <td className="px-3 py-3 font-medium">{a.actor}</td>
            <td className="px-3 py-3"><Badge tone={a.action.includes('force') || a.action === 'purge' ? 'red' : a.action.includes('view') || a.action === 'reverse_search' ? 'blue' : 'gray'}>{a.action.replace(/_/g, ' ')}</Badge></td>
            <td className="px-3 py-3 text-slate-600">{a.salesman ?? (a.dealer_id ? `Dealer #${a.dealer_id}` : '—')}</td>
            <td className="max-w-md px-3 py-3 font-mono text-xs text-slate-500">{Object.keys(a.detail).length ? JSON.stringify(a.detail) : '—'}</td>
          </tr>
        ))}
      </Table>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
    </section>
  )
}

export default function FieldSettings() {
  const { me } = useOutletContext<{ me: Me }>()
  const [rev, setRev] = useState(0)
  const { data, loading, error } = useApi<Config>(`/api/management/field/config/?r=${rev}`)
  const admin = me.role === 'admin'
  return (
    <>
      <PageHeader title="Field Settings" />
      {loading && <p className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="text-red-600">Could not load settings.</p>}
      {data && <ConfigForm key={data.updated_at} cfg={data} canEdit={admin} onSaved={() => setRev((n) => n + 1)} />}
      {admin ? <AuditLog /> : <p className="text-sm text-slate-500">The audit log is visible to administrators only.</p>}
    </>
  )
}
