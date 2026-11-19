import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { api, ApiError } from '../auth'
import { Button, flatten, StateSelect } from '../components/ui'

export interface EditableDealer { id: number; name: string; address: string; city: string; state: string; pincode: string }

const input = 'h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900'
const label = 'flex flex-col gap-1 text-xs font-medium text-slate-600'

const errText = (e: unknown) => (e instanceof ApiError ? flatten(e.data).join(' · ') || 'Could not save. Please try again.' : 'Network error. Please try again.')

/** Small "Edit" button; `name` is the accessible name, e.g. "Edit dealer name". */
export function EditButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={name}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
      <Pencil size={13} aria-hidden />Edit
    </button>
  )
}

/**
 * Inline form for the dealer's name or its address (address, city, state, pincode). Saves with
 * PATCH /api/dealers/:id/, which lets the owning salesman change exactly these fields.
 */
export function DealerEditor({ part, dealer, onClose, onSaved }: { part: 'name' | 'address'; dealer: EditableDealer; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: dealer.name, address: dealer.address, city: dealer.city, state: dealer.state, pincode: dealer.pincode })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const body: Record<string, string> = part === 'name'
      ? { name: f.name.trim() }
      : { address: f.address.trim(), city: f.city.trim(), state: f.state, pincode: f.pincode.trim() }
    if (part === 'name' && !body.name) return setErr('Dealer name cannot be blank.')
    if (part === 'address' && body.pincode && !/^\d{6}$/.test(body.pincode)) return setErr('Pincode must be 6 digits.')
    setBusy(true); setErr('')
    try { await api(`/api/dealers/${dealer.id}/`, { method: 'PATCH', body }); onSaved() }
    catch (x) { setErr(errText(x)) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()} className="flex flex-col gap-3 rounded-xl border bg-white p-3 shadow-card" aria-label={part === 'name' ? 'Edit dealer name' : 'Edit dealer address'}>
      {part === 'name' ? (
        <label className={label}>Dealer name
          <input autoFocus value={f.name} maxLength={200} onChange={(e) => set('name')(e.target.value)} className={input} />
        </label>
      ) : (
        <>
          <label className={label}>Address
            <textarea autoFocus rows={3} value={f.address} onChange={(e) => set('address')(e.target.value)} className="w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>City
              <input value={f.city} maxLength={80} onChange={(e) => set('city')(e.target.value)} className={input} />
            </label>
            <label className={label}>Pincode
              <input value={f.pincode} inputMode="numeric" maxLength={6} onChange={(e) => set('pincode')(e.target.value.replace(/\D/g, ''))} className={input} />
            </label>
          </div>
          <label className={label}>State
            <StateSelect value={f.state} onChange={set('state')} className={input} />
          </label>
        </>
      )}
      {err && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" loading={busy}>Save</Button>
      </div>
    </form>
  )
}
