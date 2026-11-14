import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, CircleAlert, CircleCheck, Inbox, Info, LoaderCircle, Search, X } from 'lucide-react'
import { api } from '../auth'
import { INDIAN_STATES } from '../states'

/* ───────────────────────── data helpers ───────────────────────── */

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [tick, setTick] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(false)
    api<T>(path)
      .then((d) => { if (live) { setData(d); setUpdatedAt(new Date().toISOString()) } })
      .catch(() => live && setError(true))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [path, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload, /** ISO time the current `data` arrived. */ updatedAt }
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export { fieldErrors, flatten, fmtDate, fmtRelative, fmtTime, qs } from './logic'

/* ───────────────────────── primitives ───────────────────────── */

export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'
const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
  ghost: 'text-slate-700 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  accent: 'bg-accent text-primary hover:brightness-95', // navy on orange is 5.5:1; white on orange is not AA
}

/** Class string so <Link> and <a> can look exactly like <Button>. */
export const buttonClass = (variant: Variant = 'primary', size: 'sm' | 'md' = 'md', extra = '') =>
  `inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'} ${VARIANT[variant]} ${extra}`

export function Button({ variant = 'primary', size = 'md', loading, className = '', children, disabled, type = 'button', ...rest }:
  { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...rest}>
      {loading && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

export function Card({ className = '', children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-xl border bg-white shadow-card ${className}`} {...rest}>{children}</div>
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-slate-200/70 ${className}`} />
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500">{icon ?? <Inbox size={20} aria-hidden />}</span>
      <p className="font-medium text-slate-900">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ message = 'Could not load data.', onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-red-50 text-red-600"><CircleAlert size={20} aria-hidden /></span>
      <p className="font-medium text-slate-900">{message}</p>
      <p className="mt-1 text-sm text-slate-500">Check your connection and try again.</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

export function StatStrip({ items }: { items: { label: string; value: number | string; tone?: 'red' | 'amber' }[] }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[repeat(var(--n),minmax(0,1fr))]" style={{ '--n': items.length } as React.CSSProperties}>
      {items.map((i) => (
        <Card key={i.label} className="px-4 py-3">
          <div className={`text-xl font-semibold tabular-nums ${i.tone === 'red' ? 'text-red-700' : i.tone === 'amber' ? 'text-amber-800' : 'text-slate-900'}`}>{i.value}</div>
          <div className="text-xs text-slate-500">{i.label}</div>
        </Card>
      ))}
    </div>
  )
}

export function Pills<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={`h-8 rounded-full px-4 text-sm font-medium transition-colors ${value === v ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{l}</button>
      ))}
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="mb-4 flex h-10 items-center gap-2 rounded-lg border bg-white px-3 focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15">
      <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="h-full w-full bg-transparent text-sm outline-none focus-visible:border-transparent focus-visible:shadow-none" />
      {value && <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="rounded p-1 text-slate-400 hover:text-slate-700"><X size={14} aria-hidden /></button>}
    </div>
  )
}

export function Select({ label, value, onChange, children }: { label?: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 rounded-lg border bg-white px-3 text-sm font-normal text-slate-900">{children}</select>
    </label>
  )
}

/**
 * Select-style dropdown whose list always opens *below* the field (scrolls inside a fixed max height).
 * A native <select> lets the browser pick the direction, and it flips upward when the field sits low
 * on the screen. Use this for long lists (e.g. states) in filter rows. Keyboard: ↑ ↓ Home End,
 * Enter/Space to pick, Esc to close, type to jump to a matching option.
 */
export function DropdownSelect({ label, value, onChange, options }: { label?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const selected = options.findIndex((o) => o.value === value)
  const last = options.length - 1

  const show = () => { setActive(Math.max(0, selected)); setOpen(true) }
  const pick = (i: number) => { onChange(options[i].value); setOpen(false); button.current?.focus() }

  // Close when the pointer goes down anywhere outside the field.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  // Keep the highlighted option visible by scrolling the list itself (never the page).
  useEffect(() => {
    const ul = list.current
    const el = open ? (ul?.children[active] as HTMLElement | undefined) : undefined
    if (!ul || !el) return
    if (el.offsetTop < ul.scrollTop) ul.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = el.offsetTop + el.offsetHeight - ul.clientHeight
  }, [open, active])

  // The list always drops down, so when the field is low on screen scroll the page just enough
  // (once, on open) to bring the whole list into view.
  useEffect(() => {
    if (open) list.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  function typeahead(key: string) {
    const t = typed.current
    const now = Date.now()
    t.text = now - t.at < 700 ? t.text + key.toLowerCase() : key.toLowerCase()
    t.at = now
    const i = options.findIndex((o) => o.label.toLowerCase().startsWith(t.text))
    if (i >= 0) setActive(i)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const typing = e.key.length === 1 && (e.key !== ' ' || Date.now() - typed.current.at < 700)
    if (typing) { e.preventDefault(); if (!open) show(); typeahead(e.key); return }
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show() }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => Math.min(last, a + 1)); break
      case 'ArrowUp': e.preventDefault(); setActive((a) => Math.max(0, a - 1)); break
      case 'Home': e.preventDefault(); setActive(0); break
      case 'End': e.preventDefault(); setActive(last); break
      case 'Enter': case ' ': e.preventDefault(); pick(active); break
      case 'Escape': e.preventDefault(); setOpen(false); break
      case 'Tab': setOpen(false); break
    }
  }

  return (
    <div ref={root} className="relative flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label && <label id={`${id}-l`} htmlFor={`${id}-b`}>{label}</label>}
      <button ref={button} id={`${id}-b`} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-o${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKeyDown}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 text-left text-sm font-normal text-slate-900 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
        <span className="truncate">{options[selected]?.label ?? ''}</span>
        <ChevronDown aria-hidden className={`size-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-labelledby={label ? `${id}-l` : undefined}
          className="absolute left-0 top-full z-30 mt-1 max-h-64 w-max min-w-full max-w-sm overflow-y-auto rounded-lg border bg-white py-1 shadow-lg">
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-o${i}`} role="option" aria-selected={i === selected}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => pick(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-normal text-slate-900 ${i === active ? 'bg-primary-soft' : ''} ${i === selected ? 'font-semibold text-primary' : ''}`}>
              {o.label}
              {i === selected && <Check aria-hidden className="size-4 shrink-0" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Label + control + inline error, wired with aria so screen readers announce the problem. */
export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string; className: string }) => React.ReactNode }) {
  const id = useId()
  const desc = error ? `${id}-e` : hint ? `${id}-h` : undefined
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700">{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': desc, className: `h-10 w-full rounded-lg border bg-white px-3 text-sm ${error ? 'border-red-400' : ''}` })}
      {error ? <p id={`${id}-e`} role="alert" className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p id={`${id}-h`} className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}

// Dropdown of Indian states / UTs. A saved value that isn't on the list (older free-text data) stays
// selectable, so editing an existing dealer never silently blanks or rewrites its state.
export function StateSelect({ value, onChange, className, placeholder = 'Select state', id }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; /** Pass Field's id so its label is linked to the control. */ id?: string }) {
  const legacy = value && !INDIAN_STATES.includes(value) ? value : null
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{placeholder}</option>
      {legacy && <option value={legacy}>{legacy}</option>}
      {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  )
}

export type Tone = 'blue' | 'red' | 'gray' | 'green' | 'amber' | 'orange'
const TONES: Record<Tone, string> = {
  blue: 'border-primary-line bg-primary-soft text-primary',
  red: 'border-red-200 bg-red-50 text-red-700',
  gray: 'border-slate-200 bg-slate-100 text-slate-600',
  green: 'border-green-200 bg-green-50 text-green-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  orange: 'border-orange-200 bg-accent-soft text-accent-ink',
}
export function Badge({ children, tone = 'blue' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>
}

/* ───────────────────────── table ───────────────────────── */

export interface Column { label: string; right?: boolean; onSort?: () => void; sorted?: 'asc' | 'desc' | null }

export function Table({ head, children, empty, loading, error, emptyTitle = 'Nothing to show', emptyHint, onRetry }:
  { head: Column[]; children: React.ReactNode; empty?: boolean; loading?: boolean; error?: boolean; emptyTitle?: string; emptyHint?: string; onRetry?: () => void }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              {head.map((h) => (
                <th key={h.label} scope="col" aria-sort={h.sorted === 'asc' ? 'ascending' : h.sorted === 'desc' ? 'descending' : undefined}
                  className={`whitespace-nowrap px-3 py-3 font-medium first:pl-4 last:pr-4 ${h.right ? 'text-right' : ''}`}>
                  {h.onSort ? (
                    <button type="button" onClick={h.onSort} className={`-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase tracking-wide hover:text-slate-900 ${h.sorted ? 'text-slate-900' : ''}`}>
                      {h.label}
                      {h.sorted === 'asc' ? <ChevronUp size={14} aria-hidden /> : h.sorted === 'desc' ? <ChevronDown size={14} aria-hidden /> : <ChevronsUpDown size={14} className="opacity-50" aria-hidden />}
                    </button>
                  ) : h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y [&>tr:hover]:bg-slate-50/70 [&_td]:px-3 [&_td]:py-3 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4">
            {loading && Array.from({ length: 5 }, (_, r) => (
              <tr key={r} aria-hidden>{head.map((h, c) => <td key={h.label}><Skeleton className={`h-4 ${c === 0 ? 'w-32' : 'w-20'}`} /></td>)}</tr>
            ))}
            {!loading && !error && children}
          </tbody>
        </table>
      </div>
      {loading && <span className="sr-only" role="status">Loading…</span>}
      {error && <ErrorState onRetry={onRetry} />}
      {!loading && !error && empty && <EmptyState title={emptyTitle} hint={emptyHint} />}
    </div>
  )
}

export function Pager({ page, count, onChange, size = 25 }: { page: number; count: number; onChange: (p: number) => void; size?: number }) {
  const pages = Math.max(1, Math.ceil(count / size))
  if (pages === 1) return null
  const from = (page - 1) * size + 1
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-slate-500">Showing {from}–{Math.min(page * size, count)} of {count}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={14} aria-hidden />Previous</Button>
        <span className="px-1 text-slate-500">Page {page} of {pages}</span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next<ChevronRight size={14} aria-hidden /></Button>
      </div>
    </nav>
  )
}

/* ───────────────────────── modal, confirm, toast ───────────────────────── */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Accessible dialog: focus moves in, Tab is trapped, Esc closes, focus returns to the opener. */
export function Modal({ title, onClose, children, width = 'max-w-md' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  const titleId = useId()
  // Read during the first render, before the dialog mounts: an autoFocus field inside it steals focus at
  // commit time, so by the time an effect runs document.activeElement is no longer the element that opened it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const el = box.current
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return }
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (!items.length) return e.preventDefault()
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; opener?.focus?.() }
  }, [opener])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/40 p-0 backdrop-blur-[1px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`max-h-[90vh] w-full ${width} overflow-y-auto rounded-t-2xl bg-white p-6 shadow-pop outline-none sm:rounded-2xl`}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" aria-label="Close dialog" onClick={onClose} className="-mr-2 -mt-1 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"><X size={18} aria-hidden /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

interface ConfirmOptions { title: string; message?: React.ReactNode; confirmLabel?: string; danger?: boolean }
interface Toast { id: number; message: string; tone: 'success' | 'error' | 'info' }
const UiContext = createContext<{ toast: (message: string, tone?: Toast['tone']) => void; confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null)

/** Mount once. Gives every page `useToast()` and a promise-based `useConfirm()` that replaces window.confirm. */
export function UiProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ask, setAsk] = useState<(ConfirmOptions & { done: (ok: boolean) => void }) | null>(null)
  const seq = useRef(0)

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000)
  }, [])
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((done) => setAsk({ ...o, done })), [])
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm])
  const answer = (ok: boolean) => { ask?.done(ok); setAsk(null) }

  return (
    <UiContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-white p-4 text-sm shadow-pop ${t.tone === 'error' ? 'border-red-200' : t.tone === 'info' ? 'border-primary-line' : 'border-green-200'}`}>
            {t.tone === 'error' ? <CircleAlert size={18} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
              : t.tone === 'info' ? <Info size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              : <CircleCheck size={18} className="mt-0.5 shrink-0 text-green-600" aria-hidden />}
            <span className="flex-1 text-slate-800">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-slate-400 hover:text-slate-700"><X size={16} aria-hidden /></button>
          </div>
        ))}
      </div>
      {ask && (
        <Modal title={ask.title} onClose={() => answer(false)} width="max-w-sm">
          {ask.message && <div className="mb-6 text-sm text-slate-600">{ask.message}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" autoFocus onClick={() => answer(false)}>Cancel</Button>
            <Button variant={ask.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>{ask.confirmLabel ?? 'Confirm'}</Button>
          </div>
        </Modal>
      )}
    </UiContext.Provider>
  )
}

function useUi() {
  const c = useContext(UiContext)
  if (!c) throw new Error('UiProvider is missing')
  return c
}
export const useToast = () => useUi().toast
export const useConfirm = () => useUi().confirm
