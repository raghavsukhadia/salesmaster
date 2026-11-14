import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LoaderCircle, Search, Store, User, X } from 'lucide-react'
import { api } from '../auth'
import { qs, useDebounced } from './ui'

interface DealerHit { id: number; name: string; phone: string; location: string; owner: string | null }
interface DealersRes { count: number; results: DealerHit[] }
interface SalesmanHit { id: number; name: string; phone: string; username: string; active: boolean }
interface Item { key: string; to: string; title: string; sub: string; kind: 'dealer' | 'salesman' | 'all' }

// The salesmen endpoint has no search parameter and returns everyone (a short list), so fetch once and filter here.
let cache: { at: number; rows: Promise<SalesmanHit[]> } | null = null
function allSalesmen() {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = { at: Date.now(), rows: api<SalesmanHit[]>('/api/management/salesmen/').catch((e) => { cache = null; throw e }) }
  }
  return cache.rows
}

const SHOWN = 5
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Search dealers (name, phone, city) and salesmen (name, username, phone). Managers and admins only. */
export default function GlobalSearch() {
  const nav = useNavigate()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 250)
  const [focused, setFocused] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [active, setActive] = useState(0)
  const [state, setState] = useState<{ for: string; dealers: DealersRes; salesmen: SalesmanHit[] } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const ready = dq.length >= 2
  const loading = ready && state?.for !== dq && failed !== dq

  useEffect(() => {
    if (dq.length < 2) return
    let live = true
    Promise.all([api<DealersRes>(`/api/management/dealers/?${qs({ q: dq, archive: 'all' })}`), allSalesmen()])
      .then(([dealers, all]) => {
        if (!live) return
        const n = dq.toLowerCase()
        setState({ for: dq, dealers, salesmen: all.filter((s) => [s.name, s.username, s.phone].some((v) => v?.toLowerCase().includes(n))) })
        setActive(0)
      })
      .catch(() => live && setFailed(dq))
    return () => { live = false }
  }, [dq])

  const items = useMemo<Item[]>(() => {
    if (!ready || state?.for !== dq) return []
    const out: Item[] = state.dealers.results.slice(0, SHOWN).map((d) => ({
      key: `d${d.id}`, kind: 'dealer', to: `/dealers/${d.id}`, title: d.name, sub: [d.location, d.phone].filter(Boolean).join(' · ') || 'No location on file',
    }))
    out.push(...state.salesmen.slice(0, SHOWN).map((s): Item => ({
      key: `s${s.id}`, kind: 'salesman', to: `/salesmen/${s.id}`, title: s.name, sub: [s.active ? 'Active' : 'Inactive', s.phone].join(' · '),
    })))
    if (state.dealers.count > SHOWN) out.push({ key: 'all', kind: 'all', to: `/dealers?q=${encodeURIComponent(dq)}`, title: `See all ${state.dealers.count} dealers matching “${dq}”`, sub: '' })
    return out
  }, [ready, state, dq])

  function go(it: Item | undefined) {
    if (!it) return
    nav(it.to)
    setQ(''); setFocused(false); setMobile(false)
    input.current?.blur()
  }

  // "/" and Ctrl/⌘+K focus the search from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.matches?.('input,textarea,select,[contenteditable="true"]')
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault()
        if (window.matchMedia('(min-width: 768px)').matches) input.current?.focus()
        else setMobile(true)
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  useEffect(() => { if (mobile) input.current?.focus() }, [mobile])

  // Close when focus or a click lands outside the search box.
  useEffect(() => {
    if (!focused) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setFocused(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [focused])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items.length) go(items[active]); else if (q.trim()) go({ key: 'q', kind: 'all', to: `/dealers?q=${encodeURIComponent(q.trim())}`, title: '', sub: '' }) }
    else if (e.key === 'Escape') { setFocused(false); setMobile(false); input.current?.blur() }
  }

  const open = focused
  const groups: { label: string; kind: Item['kind'] }[] = [{ label: 'Dealers', kind: 'dealer' }, { label: 'Salesman', kind: 'salesman' }]

  return (
    <>
      <button type="button" aria-label="Search dealers and salesmen" onClick={() => setMobile(true)}
        className="grid size-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden"><Search size={18} aria-hidden /></button>
      <div ref={box} role="search"
        className={`${mobile ? 'fixed inset-x-0 top-0 z-50 border-b bg-white p-3 shadow-pop' : 'hidden'} md:relative md:z-auto md:block md:border-0 md:bg-transparent md:p-0 md:shadow-none`}>
        <div className="flex h-10 items-center gap-2 rounded-lg border bg-white px-3 focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15 md:w-56 lg:w-64 xl:w-80">
          <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setFocused(true) }} onFocus={() => setFocused(true)} onKeyDown={onKeyDown}
            role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
            aria-activedescendant={open && items[active] ? `${listId}-${items[active].key}` : undefined}
            aria-label="Search dealers and salesmen" placeholder="Search dealers, salesmen…"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:border-transparent focus-visible:shadow-none" />
          {q ? <button type="button" aria-label="Clear search" onClick={() => { setQ(''); input.current?.focus() }} className="rounded p-1 text-slate-400 hover:text-slate-700"><X size={14} aria-hidden /></button>
            : <kbd className="hidden rounded border bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 lg:block">{isMac ? '⌘K' : 'Ctrl K'}</kbd>}
          {mobile && <button type="button" onClick={() => { setMobile(false); setFocused(false) }} className="text-sm font-medium text-slate-600 md:hidden">Cancel</button>}
        </div>

        {open && (
          <div className="absolute left-3 right-3 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border bg-white shadow-pop md:left-0 md:right-auto md:mt-2 md:w-[26rem]">
            {!ready && <p className="px-4 py-6 text-center text-sm text-slate-500">Type at least 2 characters to search dealers and salesmen.</p>}
            {ready && loading && <p role="status" className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-slate-500"><LoaderCircle size={16} className="animate-spin" aria-hidden />Searching…</p>}
            {ready && failed === dq && <p role="alert" className="px-4 py-6 text-center text-sm text-red-600">Search failed. Check your connection and try again.</p>}
            {ready && !loading && failed !== dq && items.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">No dealers or salesmen match “{dq}”.</p>}
            {items.length > 0 && (
              <ul id={listId} role="listbox" aria-label="Search results" className="py-1">
                {groups.map((g) => {
                  const rows = items.filter((i) => i.kind === g.kind)
                  if (!rows.length) return null
                  return [
                    <li key={g.kind} role="presentation" className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">{g.label}</li>,
                    ...rows.map((it) => <Row key={it.key} id={`${listId}-${it.key}`} it={it} on={items[active]?.key === it.key} onPick={() => go(it)} onHover={() => setActive(items.indexOf(it))} />),
                  ]
                })}
                {items.filter((i) => i.kind === 'all').map((it) => (
                  <Row key={it.key} id={`${listId}-${it.key}`} it={it} on={items[active]?.key === it.key} onPick={() => go(it)} onHover={() => setActive(items.indexOf(it))} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function Row({ id, it, on, onPick, onHover }: { id: string; it: Item; on: boolean; onPick: () => void; onHover: () => void }) {
  const Icon = it.kind === 'dealer' ? Store : User
  return (
    <li id={id} role="option" aria-selected={on} onMouseDown={(e) => e.preventDefault()} onClick={onPick} onMouseEnter={onHover}
      className={`flex cursor-pointer items-center gap-3 px-4 py-2 ${on ? 'bg-primary-soft' : ''} ${it.kind === 'all' ? 'border-t text-sm font-medium text-primary' : ''}`}>
      {it.kind !== 'all' && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600"><Icon size={16} aria-hidden /></span>}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-slate-900">{it.kind === 'all' ? <span className="text-primary">{it.title}</span> : it.title}</span>
        {it.sub && <span className="block truncate text-xs text-slate-500">{it.sub}</span>}
      </span>
    </li>
  )
}
