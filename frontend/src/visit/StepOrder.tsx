import { useState } from 'react'
import { ArrowLeft, CalendarClock, CircleAlert, MapPin, Minus, PackagePlus, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '../auth'
import { Badge, Button, Card, flatten, qs, useApi, useDebounced } from '../components/ui'
import { draftPayload } from './dealerDraft.ts'
import { localDate } from './format.ts'
import { fmtPaise, lineTotalPaise, orderTotalPaise, parsePaise, toOrderItems, UNITS, type OrderLine, type Unit } from './orderMath.ts'
import PhotosPanel from './PhotosPanel'
import { usePhotoState } from './photoState.ts'
import type { Chosen, DealerLite } from './types.ts'

export type Priority = 'low' | 'medium' | 'high'

export interface OrderState {
  hasOrder: boolean
  lines: OrderLine[]
  notes: string
  geo: { lat: number; lng: number } | null
  followup: { on: boolean; date: string; time: string; priority: Priority; notes: string }
}

export const EMPTY_ORDER: OrderState = {
  hasOrder: false, lines: [], notes: '', geo: null,
  followup: { on: false, date: '', time: '', priority: 'medium', notes: '' },
}

export interface Saved { visit_id: number; dealer_id: number; created: boolean }

interface ProductLite { id: number; name: string; category: string }

const localTime = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

const input = 'h-10 w-full rounded-lg border bg-white px-3 text-sm'
const lbl = 'mb-1 block text-xs font-medium text-slate-700'

function ProductResults({ q, onPick }: { q: string; onPick: (p: ProductLite) => void }) {
  const { data, loading } = useApi<ProductLite[]>(`/api/products/?${qs({ q })}`)
  if (loading && !data) return <p role="status" className="text-sm text-slate-500">Searching…</p>
  if (!data?.length) return <p className="text-sm text-slate-500">No product matches “{q}”. Add it as an other item below.</p>
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-white">
      {data.map((p) => (
        <li key={p.id}>
          <button type="button" onClick={() => onPick(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50">
            <span className="min-w-0 truncate font-medium text-slate-900">{p.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">{p.category}<Plus size={14} className="text-primary" aria-hidden /></span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export default function StepOrder({ chosen, order, setOrder, requestId, onBack, onSaved, onUseDealer }: {
  chosen: Chosen
  order: OrderState
  setOrder: (f: (o: OrderState) => OrderState) => void
  requestId: string
  onBack: () => void
  onSaved: (r: Saved) => void
  /** A "new" dealer turned out to exist already: switch the visit over to it. */
  onUseDealer: (d: DealerLite) => void
}) {
  const [pq, setPq] = useState('')
  const dpq = useDebounced(pq)
  const [custom, setCustom] = useState('')
  const [geoMsg, setGeoMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [duplicate, setDuplicate] = useState<DealerLite | null>(null)
  const photos = usePhotoState(requestId) // car photos: uploaded as they are chosen; the server enforces the minimum

  const { hasOrder, lines, notes, geo, followup: fu } = order
  const today = localDate()
  const set = (patch: Partial<OrderState>) => setOrder((o) => ({ ...o, ...patch }))
  const setFu = (patch: Partial<OrderState['followup']>) => setOrder((o) => ({ ...o, followup: { ...o.followup, ...patch } }))
  const setLine = (key: string, patch: Partial<OrderLine>) => setOrder((o) => ({ ...o, lines: o.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))

  function addLine(it: { product_id?: number; product_name: string }) {
    setOrder((o) => {
      const same = o.lines.find((l) => (it.product_id ? l.product_id === it.product_id : !l.product_id && l.product_name.toLowerCase() === it.product_name.toLowerCase()))
      if (same) return { ...o, lines: o.lines.map((l) => (l === same ? { ...l, quantity: Math.min(100000, l.quantity + 1) } : l)) }
      return { ...o, lines: [...o.lines, { ...it, key: crypto.randomUUID(), quantity: 1, unit: 'pcs', unit_price: '' }] }
    })
  }

  function captureLocation() {
    if (!navigator.geolocation) return setGeoMsg('Location is not supported on this device.')
    setGeoMsg('Getting location…')
    navigator.geolocation.getCurrentPosition(
      (p) => { set({ geo: { lat: p.coords.latitude, lng: p.coords.longitude } }); setGeoMsg('') },
      () => setGeoMsg('Could not get your location. You can still save without it.'),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  function problems(): string[] {
    const out: string[] = []
    if (hasOrder && lines.length === 0) out.push('Add at least one product to the order, or choose “No order”.')
    for (const l of lines) if (parsePaise(l.unit_price) === null) out.push(`Fix the price for ${l.product_name}.`)
    if (fu.on) {
      if (!fu.date) out.push('Choose a follow-up date.')
      else if (fu.date < today) out.push('The follow-up date cannot be in the past.')
      else if (fu.date === today && fu.time && fu.time < localTime(new Date(Date.now() - 5 * 60_000))) out.push('That follow-up time has already passed today.')
    }
    if (photos.problem) out.push(photos.problem)
    return out
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    const local = problems()
    if (local.length) return setErrors(local)

    const body: Record<string, unknown> = {
      client_request_id: requestId,
      notes: notes.trim(),
      has_order: hasOrder,
      ...(chosen.kind === 'existing' ? { dealer_id: chosen.dealer.id } : { new_dealer: draftPayload(chosen.draft) }),
      ...(hasOrder && { order_items: toOrderItems(lines) }),
      ...(photos.ids.length > 0 && { photo_ids: photos.ids }),
      ...(geo && { latitude: geo.lat.toFixed(6), longitude: geo.lng.toFixed(6) }),
      ...(fu.on && { followup: { due_date: fu.date, ...(fu.time && { due_time: fu.time }), priority: fu.priority, ...(fu.notes.trim() && { notes: fu.notes.trim() }) } }),
    }

    setSubmitting(true); setErrors([]); setDuplicate(null)
    try {
      onSaved(await api<Saved>('/api/visits/record/', { method: 'POST', body }))
    } catch (err) {
      if (err instanceof ApiError) {
        const d = err.data as { code?: string; dealer?: DealerLite } | null
        if (err.status === 409 && d?.code === 'duplicate_dealer' && d.dealer) setDuplicate(d.dealer)
        else if (err.status === 409) setErrors(['This dealer is not available to you.'])
        else if (err.status === 404) setErrors(['That dealer was not found. Go back and choose again.'])
        else if (err.status === 400) setErrors(flatten(err.data))
        else if (err.status === 403) setErrors(['Your account cannot record visits. Contact your manager.'])
        else setErrors(['Something went wrong on our side. Everything you entered is kept: please try again.'])
      } else setErrors(['No connection. Everything you entered is kept: please try again.'])
    } finally {
      setSubmitting(false)
    }
  }

  const dealerName = chosen.kind === 'existing' ? chosen.dealer.name : chosen.draft.name
  const dealerSub = chosen.kind === 'existing' ? [chosen.dealer.city, chosen.dealer.phone].filter(Boolean).join(' · ') : [chosen.draft.city, chosen.draft.phone].filter(Boolean).join(' · ')
  const total = orderTotalPaise(lines)
  const timeNote = fu.on && fu.date === today && !fu.time ? 'No time: it will be due any time today.' : ''

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      <Card className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900"><span className="truncate">{dealerName}</span>{chosen.kind === 'new' && <Badge tone="orange">New dealer</Badge>}</p>
          <p className="truncate text-xs text-slate-500">{dealerSub || 'Dealer'}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onBack}>Change</Button>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Order details</h2>
        <p className="mt-0.5 text-sm text-slate-500">Did the dealer place an order on this visit?</p>

        <div className="mt-4 grid max-w-sm grid-cols-2 gap-2" role="group" aria-label="Order placed">
          {[true, false].map((v) => (
            <button key={String(v)} type="button" aria-pressed={hasOrder === v} onClick={() => set({ hasOrder: v })}
              className={`h-10 rounded-lg border text-sm font-medium transition-colors ${hasOrder === v ? 'border-primary bg-primary text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
              {v ? 'Order placed' : 'No order'}
            </button>
          ))}
        </div>

        {hasOrder && (
          <div className="mt-5 space-y-4">
            <div>
              <label htmlFor="product-search" className={lbl}>Add a product from the catalogue</label>
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
                <input id="product-search" placeholder="Search products" value={pq} onChange={(e) => setPq(e.target.value)} autoComplete="off" className={`${input} pl-9`} />
              </div>
              {dpq.trim() && <div className="mt-2"><ProductResults q={dpq.trim()} onPick={(p) => { addLine({ product_id: p.id, product_name: p.name }); setPq('') }} /></div>}
            </div>

            <div>
              <label htmlFor="custom-item" className={lbl}>Or add another item</label>
              <div className="flex gap-2">
                <input id="custom-item" placeholder="Item not in the catalogue" value={custom} maxLength={200} onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) { e.preventDefault(); addLine({ product_name: custom.trim() }); setCustom('') } }} className={input} />
                <Button variant="secondary" disabled={!custom.trim()} onClick={() => { addLine({ product_name: custom.trim() }); setCustom('') }}><PackagePlus size={16} aria-hidden />Add</Button>
              </div>
            </div>

            {lines.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-slate-500">No items added yet.</p>
            ) : (
              <ul className="space-y-3" aria-label="Order items">
                {lines.map((l) => {
                  const bad = parsePaise(l.unit_price) === null
                  return (
                    <li key={l.key} className="rounded-xl border bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 font-medium text-slate-900">{l.product_name}{!l.product_id && <span className="ml-1.5 text-xs font-normal text-slate-500">(other item)</span>}</p>
                        <button type="button" aria-label={`Remove ${l.product_name}`} onClick={() => setOrder((o) => ({ ...o, lines: o.lines.filter((x) => x.key !== l.key) }))}
                          className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"><Trash2 size={16} aria-hidden /></button>
                      </div>
                      <div className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-2 sm:grid-cols-[auto_8rem_1fr_auto] sm:items-end">
                        <div>
                          <span className={lbl}>Quantity</span>
                          <div className="flex h-10 items-center overflow-hidden rounded-lg border bg-white">
                            <button type="button" aria-label={`Decrease quantity of ${l.product_name}`} disabled={l.quantity <= 1} onClick={() => setLine(l.key, { quantity: l.quantity - 1 })} className="grid h-full w-9 place-items-center text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Minus size={14} aria-hidden /></button>
                            <input aria-label={`Quantity of ${l.product_name}`} type="number" inputMode="numeric" min={1} max={100000} value={l.quantity}
                              onChange={(e) => setLine(l.key, { quantity: Math.min(100000, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })}
                              className="h-full w-14 border-0 text-center text-sm [appearance:textfield] focus-visible:ring-0 [&::-webkit-inner-spin-button]:appearance-none" />
                            <button type="button" aria-label={`Increase quantity of ${l.product_name}`} disabled={l.quantity >= 100000} onClick={() => setLine(l.key, { quantity: l.quantity + 1 })} className="grid h-full w-9 place-items-center text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Plus size={14} aria-hidden /></button>
                          </div>
                        </div>
                        <div>
                          <label htmlFor={`u-${l.key}`} className={lbl}>Unit</label>
                          <select id={`u-${l.key}`} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value as Unit })} className={input}>
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`p-${l.key}`} className={lbl}>Price per {l.unit} (₹)</label>
                          <input id={`p-${l.key}`} inputMode="decimal" placeholder="Optional" value={l.unit_price} aria-invalid={bad || undefined} autoComplete="off"
                            onChange={(e) => setLine(l.key, { unit_price: e.target.value })} className={`${input} ${bad ? 'border-red-400' : ''}`} />
                        </div>
                        <p className="col-span-3 text-right text-sm text-slate-600 sm:col-span-1 sm:pb-2">
                          {bad ? <span className="text-red-600">Invalid price</span> : <>Line total <strong className="tabular-nums text-slate-900">{fmtPaise(lineTotalPaise(l))}</strong></>}
                        </p>
                      </div>
                    </li>
                  )
                })}
                <li className="flex items-center justify-between rounded-xl bg-primary-soft px-4 py-3 text-sm">
                  <span className="font-medium text-slate-700">Order total <span className="font-normal text-slate-500">({lines.length} {lines.length === 1 ? 'item' : 'items'})</span></span>
                  <strong className="text-base tabular-nums text-primary" data-testid="order-total">{fmtPaise(total)}</strong>
                </li>
              </ul>
            )}
          </div>
        )}
      </Card>

      <PhotosPanel requestId={requestId} />

      <Card className="space-y-4 p-4 sm:p-6">
        <div>
          <label htmlFor="visit-notes" className={lbl}>Visit notes</label>
          <textarea id="visit-notes" rows={3} maxLength={5000} value={notes} onChange={(e) => set({ notes: e.target.value })} placeholder="What was discussed, what the dealer needs, anything to remember"
            className="w-full rounded-lg border bg-white px-3 py-2 text-sm" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={captureLocation}><MapPin size={16} aria-hidden />{geo ? 'Update location' : 'Capture location'}</Button>
          {geo && <span className="text-sm text-green-700">Location captured ({geo.lat.toFixed(4)}, {geo.lng.toFixed(4)})</span>}
          {geoMsg && <span className="text-sm text-slate-500" role="status">{geoMsg}</span>}
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" checked={fu.on} onChange={(e) => setFu({ on: e.target.checked })} className="size-4" />
          <span className="flex items-center gap-2 font-semibold text-slate-900"><CalendarClock size={18} className="text-primary" aria-hidden />Schedule a follow-up</span>
        </label>
        {fu.on && (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="fu-date" className={lbl}>Date *</label>
                <input id="fu-date" type="date" min={today} max={localDate(365)} value={fu.date} onChange={(e) => setFu({ date: e.target.value })} className={input} />
              </div>
              <div>
                <label htmlFor="fu-time" className={lbl}>Time (optional)</label>
                <input id="fu-time" type="time" value={fu.time} onChange={(e) => setFu({ time: e.target.value })} className={input} />
              </div>
              <div>
                <label htmlFor="fu-priority" className={lbl}>Priority</label>
                <select id="fu-priority" value={fu.priority} onChange={(e) => setFu({ priority: e.target.value as Priority })} className={input}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Quick dates">
              {([['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]] as const).map(([label, d]) => (
                <button key={label} type="button" onClick={() => setFu({ date: localDate(d) })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${fu.date === localDate(d) ? 'border-primary bg-primary-soft text-primary' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
              ))}
            </div>
            {timeNote && <p className="text-xs text-slate-500">{timeNote}</p>}
            <div>
              <label htmlFor="fu-notes" className={lbl}>Follow-up note</label>
              <input id="fu-notes" value={fu.notes} maxLength={500} onChange={(e) => setFu({ notes: e.target.value })} placeholder="e.g. Send quotation for 20 rolls" className={input} />
            </div>
          </div>
        )}
      </Card>

      {duplicate && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-amber-900">This dealer already exists: <strong>{duplicate.name}</strong>{duplicate.city && ` · ${duplicate.city}`}.</p>
          <Button onClick={() => { onUseDealer(duplicate); setDuplicate(null) }}>Use this dealer</Button>
        </div>
      )}

      {errors.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <ul className="space-y-0.5">{errors.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={onBack} disabled={submitting}><ArrowLeft size={16} aria-hidden />Back</Button>
        <Button type="submit" loading={submitting}>{submitting ? 'Saving…' : 'Save visit'}</Button>
      </div>
    </form>
  )
}
