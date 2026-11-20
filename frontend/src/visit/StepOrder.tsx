import { useState } from 'react'
import { ArrowLeft, CalendarClock, ChevronDown, CircleAlert, MapPin, Minus, PackagePlus, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '../auth'
import { Badge, Button, Card, flatten, useApi } from '../components/ui'
import { gpsMessage, quickReading } from '../field/gps.ts'
import { tracker } from '../field/useTracker'
import { draftPayload, hasLocation } from './dealerDraft.ts'
import { fmtDue, localDate } from './format.ts'
import { fmtPaise, lineTotalPaise, orderTotalPaise, priceError, toOrderItems, UNITS, type OrderLine, type Unit } from './orderMath.ts'
import { dueDateFor, EMPTY_NEXT_STEP, NEXT_ACTIONS, nextStepFollowup, nextStepProblems, NOTE_MAX, TEXT_MAX, WHEN_OPTIONS, type NextStep } from './nextStep.ts'
import type { Chosen, DealerLite } from './types.ts'

export interface OrderState {
  hasOrder: boolean
  lines: OrderLine[]
  notes: string
  /** Where the salesman was when they tapped "Capture location". Saved as the visit's location. */
  geo: { lat: number; lng: number; accuracy_m: number } | null
  next: NextStep
}

export const EMPTY_ORDER: OrderState = {
  hasOrder: false, lines: [], notes: '', geo: null,
  next: EMPTY_NEXT_STEP,
}

export interface Saved { visit_id: number; dealer_id: number; created: boolean }

interface ProductLite { id: number; name: string; category: string }

const input = 'h-10 w-full rounded-lg border bg-white px-3 text-sm'
const lbl = 'mb-1 block text-xs font-medium text-slate-700'

/** Dropdown of the whole active catalogue: opens on focus, narrows as the salesman types (name or category). */
function ProductPicker({ onPick }: { onPick: (p: ProductLite) => void }) {
  const { data, loading, error, reload } = useApi<ProductLite[]>('/api/products/')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (data ?? []).filter((p) => {
    const hay = `${p.name} ${p.category}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })

  function pick(p: ProductLite) {
    onPick(p); setQ(''); setActive(0); setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); pick(matches[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
      <input id="product-search" role="combobox" aria-expanded={open} aria-controls="product-options" aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `product-opt-${matches[active].id}` : undefined}
        placeholder="Search or choose a product" value={q} autoComplete="off" className={`${input} pl-9 pr-9`}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border bg-white shadow-lg">
          {loading && !data ? <p role="status" className="px-3 py-2.5 text-sm text-slate-500">Loading products…</p>
            : error && !data ? (
              <p className="px-3 py-2.5 text-sm text-red-700">Could not load products.{' '}
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={reload} className="font-medium underline">Try again</button></p>
            ) : matches.length === 0 ? (
              <p className="px-3 py-2.5 text-sm text-slate-500">{q.trim() ? <>No product matches “{q.trim()}”. Add it as an other item below.</> : 'No products in the catalogue yet.'}</p>
            ) : (
              <ul id="product-options" role="listbox" aria-label="Products" className="max-h-72 divide-y overflow-y-auto">
                {matches.map((p, i) => (
                  <li key={p.id} id={`product-opt-${p.id}`} role="option" aria-selected={i === active}
                    // mousedown would blur the input (closing the list) before the click lands
                    onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} onMouseEnter={() => setActive(i)}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm ${i === active ? 'bg-slate-50' : ''}`}>
                    <span className="min-w-0 truncate font-medium text-slate-900">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">{p.category}<Plus size={14} className="text-primary" aria-hidden /></span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
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
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [duplicate, setDuplicate] = useState<DealerLite | null>(null)
  const [locBusy, setLocBusy] = useState(false)
  const [geoMsg, setGeoMsg] = useState('')

  const { hasOrder, lines, notes, geo, next } = order
  const set = (patch: Partial<OrderState>) => setOrder((o) => ({ ...o, ...patch }))
  const setNext = (patch: Partial<NextStep>) => setOrder((o) => ({ ...o, next: { ...o.next, ...patch } }))
  const setLine = (key: string, patch: Partial<OrderLine>) => setOrder((o) => ({ ...o, lines: o.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))

  function addLine(it: { product_id?: number; product_name: string }) {
    setOrder((o) => {
      const same = o.lines.find((l) => (it.product_id ? l.product_id === it.product_id : !l.product_id && l.product_name.toLowerCase() === it.product_name.toLowerCase()))
      if (same) return { ...o, lines: o.lines.map((l) => (l === same ? { ...l, quantity: Math.min(100000, l.quantity + 1) } : l)) }
      return { ...o, lines: [...o.lines, { ...it, key: crypto.randomUUID(), quantity: 1, unit: 'pcs', unit_price: '' }] }
    })
  }

  async function captureLocation() {
    setLocBusy(true); setGeoMsg('')
    try {
      const r = await quickReading({ latest: tracker.getState().position })
      set({ geo: { lat: r.latitude, lng: r.longitude, accuracy_m: r.accuracy_m } })
    } catch (e) {
      setGeoMsg(`${gpsMessage(e)} You can still save the visit without it.`)
    } finally {
      setLocBusy(false)
    }
  }

  function problems(): string[] {
    const out: string[] = []
    if (hasOrder && lines.length === 0) out.push('Add at least one product to the order, or choose “No order”.')
    if (hasOrder) for (const l of lines) if (priceError(l.unit_price)) out.push(`Fix the price of ${l.product_name}: enter an amount like 1250 or 1250.50.`)
    out.push(...nextStepProblems(next))
    return out
  }

  // The visit's location is the one tapped here; failing that, the position detected on the new-dealer form (the salesman was at the shop).
  const place = geo ? { latitude: geo.lat.toFixed(6), longitude: geo.lng.toFixed(6), ...(Number.isFinite(geo.accuracy_m) && { location_accuracy_m: geo.accuracy_m }) }
    : chosen.kind === 'new' && hasLocation(chosen.draft) ? { latitude: chosen.draft.latitude, longitude: chosen.draft.longitude } : null

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    const local = problems()
    if (local.length) return setErrors(local)

    const followup = nextStepFollowup(next)
    const body: Record<string, unknown> = {
      client_request_id: requestId,
      notes: notes.trim(),
      has_order: hasOrder,
      ...(chosen.kind === 'existing' ? { dealer_id: chosen.dealer.id } : { new_dealer: draftPayload(chosen.draft) }),
      ...(hasOrder && { order_items: toOrderItems(lines) }),
      ...(followup && { followup }),
      ...place, // latitude + longitude of the visit, when there is one
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
  const nextOn = next.action !== null && next.action !== 'nothing' // "Nothing" needs no date, text or note

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
              {v ? 'Yes' : 'No order'}
            </button>
          ))}
        </div>

        {hasOrder && (
          <div className="mt-5 space-y-4">
            <div>
              <label htmlFor="product-search" className={lbl}>Add a product from the catalogue</label>
              <ProductPicker onPick={(p) => addLine({ product_id: p.id, product_name: p.name })} />
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
                {lines.map((l) => (
                    <li key={l.key} className="rounded-xl border bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 font-medium text-slate-900">{l.product_name}{!l.product_id && <span className="ml-1.5 text-xs font-normal text-slate-500">(other item)</span>}</p>
                        <button type="button" aria-label={`Remove ${l.product_name}`} onClick={() => setOrder((o) => ({ ...o, lines: o.lines.filter((x) => x.key !== l.key) }))}
                          className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"><Trash2 size={16} aria-hidden /></button>
                      </div>
                      <div className="mt-2 grid grid-cols-[auto_1fr] gap-2 sm:grid-cols-[auto_8rem_10rem]">
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
                        <div className="col-span-2 sm:col-span-1">
                          <label htmlFor={`p-${l.key}`} className={lbl}>Price per {l.unit} <span className="font-normal text-slate-500">(optional)</span></label>
                          <div className="relative">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500" aria-hidden>₹</span>
                            <input id={`p-${l.key}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={l.unit_price} maxLength={18}
                              aria-invalid={!!priceError(l.unit_price)} aria-describedby={priceError(l.unit_price) ? `pe-${l.key}` : undefined}
                              onChange={(e) => setLine(l.key, { unit_price: e.target.value })}
                              className={`${input} pl-7 tabular-nums ${priceError(l.unit_price) ? 'border-red-400' : ''}`} />
                          </div>
                        </div>
                      </div>
                      {priceError(l.unit_price) ? <p id={`pe-${l.key}`} className="mt-1.5 text-xs text-red-700">{priceError(l.unit_price)}</p>
                        : lineTotalPaise(l) > 0 && <p className="mt-1.5 text-right text-xs text-slate-500">{l.quantity} × {fmtPaise(lineTotalPaise(l) / l.quantity)} = <span className="font-medium tabular-nums text-slate-900">{fmtPaise(lineTotalPaise(l))}</span></p>}
                    </li>
                ))}
              </ul>
            )}
            {orderTotalPaise(lines) > 0 && (
              <p className="flex items-center justify-between border-t pt-3 text-sm"><span className="text-slate-600">Order total</span><span className="font-semibold tabular-nums text-slate-900">{fmtPaise(orderTotalPaise(lines))}</span></p>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-4 sm:p-6">
        <div>
          <label htmlFor="visit-notes" className={lbl}>Visit notes</label>
          <textarea id="visit-notes" rows={3} maxLength={5000} value={notes} onChange={(e) => set({ notes: e.target.value })} placeholder="What was discussed, what the dealer needs, anything to remember"
            className="w-full rounded-lg border bg-white px-3 py-2 text-sm" />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={captureLocation} loading={locBusy}>
              {!locBusy && <MapPin size={16} aria-hidden />}{locBusy ? 'Capturing…' : geo ? 'Update location' : 'Capture location'}
            </Button>
            {geo && !locBusy && <span role="status" className="text-sm text-green-700">Location captured ({geo.lat.toFixed(4)}, {geo.lng.toFixed(4)})</span>}
          </div>
          {geoMsg && <p role="status" className="mt-2 text-sm text-red-700">{geoMsg}</p>}        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 id="next-heading" className="flex items-center gap-2 text-lg font-semibold text-slate-900"><CalendarClock size={18} className="text-primary" aria-hidden />What should you do next? <span className="text-red-600" aria-hidden>*</span></h2>

        <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-labelledby="next-heading" aria-required="true">
          {NEXT_ACTIONS.map((a) => (
            <button key={a.value} type="button" aria-pressed={next.action === a.value} onClick={() => setNext({ action: a.value })}
              className={`h-11 rounded-lg border px-2 text-sm font-medium transition-colors ${a.value === 'nothing' ? 'col-span-2' : ''} ${next.action === a.value ? 'border-primary bg-primary text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
              {a.label}
            </button>
          ))}
        </div>

        {nextOn && (
          <div className="mt-5 space-y-4">
            <div>
              <p id="when-label" className={lbl}>When? *</p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="when-label">
                {WHEN_OPTIONS.map((w) => (
                  <button key={w.value} type="button" aria-pressed={next.when === w.value} onClick={() => setNext({ when: w.value })}
                    className={`rounded-full border px-4 py-2 text-sm font-medium ${next.when === w.value ? 'border-primary bg-primary-soft text-primary' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{w.label}</button>
                ))}
              </div>
              {next.when === 'custom' && (
                <input aria-label="Follow-up date" type="date" min={localDate()} max={localDate(365)} value={next.customDate} onChange={(e) => setNext({ customDate: e.target.value })} className={`${input} mt-2 sm:max-w-xs`} />
              )}
              {dueDateFor(next) && <p className="mt-1.5 text-xs text-slate-500">Due {fmtDue(dueDateFor(next))}</p>}
            </div>

            {next.action === 'other' && (
              <div>
                <label htmlFor="next-text" className={lbl}>What to do *</label>
                <input id="next-text" value={next.text} maxLength={TEXT_MAX} onChange={(e) => setNext({ text: e.target.value })} placeholder="e.g. Confirm installation date" className={input} />
              </div>
            )}

            <div>
              <label htmlFor="next-note" className={lbl}>Add a note <span className="font-normal text-slate-500">(optional)</span></label>
              <textarea id="next-note" rows={2} maxLength={NOTE_MAX} value={next.note} onChange={(e) => setNext({ note: e.target.value })} placeholder="e.g. Dealer asked for revised PPF pricing."
                className="w-full rounded-lg border bg-white px-3 py-2 text-sm" />
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
