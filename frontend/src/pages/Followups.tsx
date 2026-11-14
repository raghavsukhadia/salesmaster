import { useState } from 'react'
import { CalendarClock, MapPin, Phone, Plus } from 'lucide-react'
import { api, ApiError } from '../auth'
import { Badge, Button, Card, EmptyState, flatten, Modal, Pager, qs, useApi, useDebounced } from '../components/ui'
import DealerPicker from '../visit/DealerPicker'
import { notifyFollowupsChanged } from '../visit/followupBadge'
import { fmtDue, localDate } from '../visit/format.ts'
import type { DealerLite } from '../visit/types.ts'

export interface FollowupRow {
  id: number; dealer: { id: number; name: string; phone: string; city: string }; due_date: string; due_time: string | null; status: string
  state: string; priority: string; outcome: string; notes: string; visit_id: number | null
}
interface Data { counts: Record<Tab, number>; count: number; results: FollowupRow[] }

type Tab = 'pending' | 'due_today' | 'overdue' | 'completed'
const TABS: [Tab, string][] = [['pending', 'Pending'], ['due_today', 'Due Today'], ['overdue', 'Overdue'], ['completed', 'Completed']]
const OUTCOMES: [string, string][] = [['interested', 'Interested'], ['call_again', 'Call again'], ['send_quotation', 'Send quotation'], ['no_answer', 'No answer'], ['not_interested', 'Not interested']]
const input = 'h-10 w-full rounded-lg border bg-white px-3 text-sm'
const lbl = 'mb-1 block text-xs font-medium text-slate-700'
const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Request failed' : 'No connection. Please try again.')

type Mode = 'complete' | 'reschedule' | 'cancel'

const STATE_TONE: Record<string, 'red' | 'green' | 'blue' | 'gray'> = { overdue: 'red', completed: 'green', due_today: 'blue' }
const STATE_LABEL: Record<string, string> = { due_today: 'Due today', upcoming: 'Upcoming', overdue: 'Overdue', completed: 'Completed', cancelled: 'Cancelled' }

function FollowupCard({ f, onDone }: { f: FollowupRow; onDone: () => void }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [outcome, setOutcome] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState(f.due_date < localDate() ? localDate() : f.due_date)
  const [time, setTime] = useState(f.due_time ?? '')
  const [priority, setPriority] = useState(f.priority)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const open = f.status === 'pending'

  const submit = async () => {
    if (!mode || busy) return
    const body = mode === 'complete' ? { outcome: outcome || undefined, notes: notes || undefined }
      : mode === 'reschedule' ? { due_date: date, due_time: time || null, priority, notes: notes || undefined } : { notes: notes || undefined }
    setBusy(true); setErr('')
    try { await api(`/api/salesman/followups/${f.id}/${mode}/`, { method: 'POST', body }); notifyFollowupsChanged(); onDone() }
    catch (e) { setErr(errText(e)); setBusy(false) }
  }
  const pick = (m: Mode) => { setMode(mode === m ? null : m); setErr(''); setNotes('') }

  return (
    <li>
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{f.dealer.name}</p>
            <p className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
              {f.dealer.city && <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden />{f.dealer.city}</span>}
              {f.dealer.phone && <span className="inline-flex items-center gap-1"><Phone size={12} aria-hidden />{f.dealer.phone}</span>}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={STATE_TONE[f.state] ?? 'gray'}>{STATE_LABEL[f.state] ?? f.state}</Badge>
            <span className="text-xs capitalize text-slate-500">{f.priority} priority</span>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-900"><CalendarClock size={15} className="text-primary" aria-hidden /><span>Due {fmtDue(f.due_date, f.due_time)}</span></p>
        {f.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{f.notes}</p>}
        {f.outcome && <p className="mt-1 text-xs text-slate-500">Outcome: {f.outcome.replace(/_/g, ' ')}</p>}

        {open && (
          <div className="mt-3 flex flex-wrap gap-2">
            {f.dealer.phone && <a href={`tel:${f.dealer.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50"><Phone size={13} aria-hidden />Call dealer</a>}
            {(['complete', 'reschedule', 'cancel'] as Mode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)}
                className={`h-8 rounded-lg border px-3 text-xs font-medium transition-colors ${mode === m ? 'border-primary bg-primary text-white' : 'bg-white text-slate-800 hover:bg-slate-50'}`}>
                {m === 'complete' ? 'Record outcome' : m === 'reschedule' ? 'Reschedule' : 'Cancel'}
              </button>
            ))}
          </div>
        )}

        {open && mode && (
          <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
            {mode === 'complete' && (
              <div>
                <label htmlFor={`o-${f.id}`} className={lbl}>Call outcome</label>
                <select id={`o-${f.id}`} value={outcome} onChange={(e) => setOutcome(e.target.value)} className={input}>
                  <option value="">No outcome</option>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            )}
            {mode === 'reschedule' && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div><label htmlFor={`d-${f.id}`} className={lbl}>New date</label><input id={`d-${f.id}`} type="date" min={localDate()} max={localDate(365)} value={date} onChange={(e) => setDate(e.target.value)} className={input} /></div>
                <div><label htmlFor={`t-${f.id}`} className={lbl}>Time (optional)</label><input id={`t-${f.id}`} type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} /></div>
                <div>
                  <label htmlFor={`p-${f.id}`} className={lbl}>Priority</label>
                  <select id={`p-${f.id}`} value={priority} onChange={(e) => setPriority(e.target.value)} className={input}>
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </div>
              </div>
            )}
            <div>
              <label htmlFor={`n-${f.id}`} className={lbl}>{mode === 'cancel' ? 'Reason (optional)' : 'Note (optional)'}</label>
              <input id={`n-${f.id}`} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} className={input} />
            </div>
            {err && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{err}</p>}
            <Button onClick={submit} loading={busy} disabled={mode === 'reschedule' && !date}>
              {busy ? 'Saving…' : mode === 'complete' ? 'Mark completed' : mode === 'reschedule' ? 'Save new date' : 'Cancel this follow-up'}
            </Button>
          </div>
        )}
      </Card>
    </li>
  )
}

/** A reminder that is not tied to a visit: pick one of your dealers, a date and an optional time. */
function NewFollowup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [dealer, setDealer] = useState<DealerLite | null>(null)
  const [date, setDate] = useState(localDate(1))
  const [time, setTime] = useState('')
  const [priority, setPriority] = useState('medium')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!dealer) return setErr('Choose the dealer this follow-up is for.')
    if (!date) return setErr('Choose a date.')
    setBusy(true); setErr('')
    try {
      await api('/api/salesman/followups/', { method: 'POST', body: { dealer_id: dealer.id, due_date: date, ...(time && { due_time: time }), priority, ...(notes.trim() && { notes: notes.trim() }) } })
      notifyFollowupsChanged()
      onDone()
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 404 ? 'That dealer is no longer available to you.' : errText(x))
      setBusy(false)
    }
  }

  return (
    <Modal title="New follow-up" onClose={onClose} width="max-w-lg">
      <form onSubmit={save} noValidate className="space-y-4">
        {err && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <div>
          <span className={lbl}>Dealer *</span>
          <DealerPicker selected={dealer} onSelect={setDealer} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label htmlFor="nf-date" className={lbl}>Date *</label><input id="nf-date" type="date" min={localDate()} max={localDate(365)} value={date} onChange={(e) => setDate(e.target.value)} className={input} /></div>
          <div><label htmlFor="nf-time" className={lbl}>Time (optional)</label><input id="nf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} /></div>
          <div>
            <label htmlFor="nf-priority" className={lbl}>Priority</label>
            <select id="nf-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={input}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </div>
        </div>
        <div><label htmlFor="nf-notes" className={lbl}>Note</label><input id="nf-notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Call about the quotation" className={input} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>{busy ? 'Saving…' : 'Create follow-up'}</Button>
        </div>
      </form>
    </Modal>
  )
}

export default function Followups() {
  const [tab, setTab] = useState<Tab>('pending')
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [page, setPage] = useState(1)
  const [v, setV] = useState(0)
  const [creating, setCreating] = useState(false)
  const { data, loading, error, reload } = useApi<Data>(`/api/salesman/followups/?${qs({ tab, q: dq, page, v })}`)

  const empty: Record<Tab, string> = {
    pending: 'No pending follow-ups. You are all caught up.', due_today: 'Nothing is due today.',
    overdue: 'No overdue follow-ups.', completed: 'No completed follow-ups yet.',
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Follow-up status" className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4 lg:max-w-2xl">
          {TABS.map(([t, label]) => {
            const n = data?.counts[t]
            return (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setPage(1) }}
                className={`flex h-10 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors ${tab === t ? 'border-primary bg-primary text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                {label}
                {n !== undefined && (
                  <span className={`rounded-full px-1.5 text-xs tabular-nums ${tab === t ? 'bg-white/20' : t === 'overdue' && n ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{n}</span>
                )}
              </button>
            )
          })}
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden />New follow-up</Button>
      </div>
      <input aria-label="Search follow-ups" placeholder="Search dealer, phone, city or notes" value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1) }} className={input} />

      {loading && !data && <p role="status" className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">Could not load follow-ups. Please refresh.</p>}
      {data && data.results.length === 0 && <Card><EmptyState title={dq ? 'No follow-ups match your search.' : empty[tab]} /></Card>}
      <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
        {data?.results.map((f) => <FollowupCard key={`${f.id}-${f.status}-${f.due_date}-${f.due_time}`} f={f} onDone={() => setV((n) => n + 1)} />)}
      </ul>
      <Pager page={page} count={data?.count ?? 0} onChange={setPage} />
      {creating && <NewFollowup onClose={() => setCreating(false)} onDone={() => { setCreating(false); setTab('pending'); setPage(1); setV((n) => n + 1); reload() }} />}
    </div>
  )
}
