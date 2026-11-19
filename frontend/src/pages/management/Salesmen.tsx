import { useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { api, ApiError, type Me } from '../../auth'
import GeneratePassword from '../../components/GeneratePassword'
import { Badge, Button, buttonClass, Field, fieldErrors, flatten, Modal, PageHeader, SearchBox, Table, useApi, useConfirm, useToast } from '../../components/ui'

interface Targets { daily_visits: number; monthly_visits: number; monthly_orders: number }
interface Row { id: number; name: string; username: string; phone: string; email: string; active: boolean; territories: string[]; targets: Targets }

export const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Request failed' : 'Network error. Please try again.')

const EMPTY = { username: '', password: '', first_name: '', last_name: '', email: '', phone_number: '' }
type Form = typeof EMPTY

function AddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Form>(EMPTY)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [fe, setFe] = useState<Record<string, string>>({})
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); if (fe[k]) setFe({ ...fe, [k]: '' }) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (f.phone_number.replace(/\D/g, '').length < 10) local.phone_number = 'Enter a 10-digit mobile number.'
    if (f.password.length < 8) local.password = 'Use at least 8 characters.'
    if (Object.keys(local).length) { setFe(local); return }
    setBusy(true)
    setErr('')
    setFe({})
    try {
      await api('/api/management/salesmen/create/', { method: 'POST', body: f })
      onDone()
    } catch (x) {
      const byField = x instanceof ApiError ? fieldErrors(x.data) : {}
      setFe(byField)
      setErr(Object.keys(byField).length ? 'Please fix the highlighted fields.' : errText(x))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add salesman" onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {err && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" error={fe.first_name}>{(p) => <input {...p} required value={f.first_name} onChange={set('first_name')} />}</Field>
          <Field label="Last name" error={fe.last_name}>{(p) => <input {...p} value={f.last_name} onChange={set('last_name')} />}</Field>
        </div>
        <Field label="Phone (10 digits)" error={fe.phone_number}>{(p) => <input {...p} required value={f.phone_number} onChange={set('phone_number')} inputMode="tel" autoComplete="off" />}</Field>
        <Field label="Email" error={fe.email}>{(p) => <input {...p} type="email" value={f.email} onChange={set('email')} />}</Field>
        <Field label="Username" error={fe.username}>{(p) => <input {...p} required value={f.username} onChange={set('username')} autoComplete="off" />}</Field>
        <Field label="Temporary password" error={fe.password} hint="Generate one, copy it, and pass it on: it cannot be shown again. You can reset it later from the salesman’s profile.">
          {(p) => (
            <>
              <input {...p} required type={reveal ? 'text' : 'password'} value={f.password} onChange={set('password')} autoComplete="new-password" spellCheck={false} />
              <GeneratePassword value={f.password} onGenerate={(pw) => { setF({ ...f, password: pw }); setReveal(true); if (fe.password) setFe({ ...fe, password: '' }) }} />
            </>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>{busy ? 'Creating…' : 'Create salesman'}</Button>
        </div>
      </form>
    </Modal>
  )
}

export default function Salesmen() {
  const { me } = useOutletContext<{ me: Me }>()
  const admin = me.role === 'admin'
  const confirm = useConfirm()
  const toast = useToast()
  const { data, loading, error, reload } = useApi<Row[]>('/api/management/salesmen/')
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (data ?? []).filter((s) => !n || [s.name, s.username, s.phone, s.email].some((v) => v?.toLowerCase().includes(n)))
  }, [data, q])

  async function act(id: number, fn: () => Promise<unknown>, done: string) {
    if (busyId) return
    setBusyId(id)
    try {
      await fn()
      toast(done)
      reload()
    } catch (x) {
      toast(errText(x), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (s: Row) => {
    if (s.active && !(await confirm({
      title: `Deactivate ${s.name}?`, confirmLabel: 'Deactivate', danger: true,
      message: 'They will be signed out and will not be able to log in until you activate them again. Their history is kept.',
    }))) return
    act(s.id, () => api(`/api/management/salesmen/${s.id}/`, { method: 'PATCH', body: { is_active: !s.active } }), s.active ? `${s.name} deactivated` : `${s.name} activated`)
  }
  const remove = async (s: Row) => {
    if (!(await confirm({
      title: `Delete ${s.name}?`, confirmLabel: 'Delete salesman', danger: true,
      message: 'This permanently removes the account. It only works for a salesman with no visits, follow-ups or dealer ownership; otherwise use Offboard.',
    }))) return
    act(s.id, () => api(`/api/management/salesmen/${s.id}/`, { method: 'DELETE' }), `${s.name} deleted`)
  }

  return (
    <>
      <PageHeader title="Salesman"
        action={admin ? <Button onClick={() => setAdding(true)}><UserPlus size={16} aria-hidden />Add salesman</Button> : undefined} />
      <SearchBox value={q} onChange={setQ} placeholder="Search by name, username, phone or email" />
      <Table stack head={[{ label: 'Name' }, { label: 'Phone' }, { label: 'Email' }, { label: 'Status' }, { label: 'Territories' }, { label: 'Actions', right: true }]}
        loading={loading && !data} error={error && !data} onRetry={reload} empty={rows.length === 0}
        emptyTitle={q ? 'No salesman matches your search' : 'No salesman yet'} emptyHint={q ? undefined : admin ? 'Use “Add salesman” to create the first account.' : undefined}>
        {rows.map((s) => (
          <tr key={s.id}>
            <td><Link to={`/salesmen/${s.id}`} className="font-medium text-slate-900 hover:text-primary hover:underline">{s.name}</Link><div className="text-xs text-slate-500">@{s.username}</div></td>
            <td className="sm:whitespace-nowrap">{s.phone}</td>
            <td>{s.email || '—'}</td>
            <td>{s.active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Inactive</Badge>}</td>
            <td>
              <div className="max-w-[16rem] text-slate-600">{s.territories.length ? s.territories.join(', ') : 'No territories assigned'}</div>
              {admin && <Link to={`/salesmen/${s.id}#territories`} className="text-xs font-medium text-primary hover:underline">Edit territories</Link>}
            </td>
            <td data-label="">
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Link to={`/salesmen/${s.id}`} className={buttonClass('soft', 'sm')}>Edit</Link>
                <Button size="sm" variant={s.active ? 'warning' : 'primary'} disabled={busyId === s.id} onClick={() => toggle(s)}>{s.active ? 'Deactivate' : 'Activate'}</Button>
                {admin && (
                  <>
                    <Link to={`/salesmen/${s.id}#offboard`} className={buttonClass('secondary', 'sm')}>Offboard</Link>
                    <Button size="sm" variant="dangerSoft" disabled={busyId === s.id} onClick={() => remove(s)}>Delete</Button>
                  </>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>
      {adding && <AddModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast('Salesman created'); reload() }} />}
    </>
  )
}
