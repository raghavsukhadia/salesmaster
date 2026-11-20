import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { useDebounced } from '../../components/ui'
import { usePopover } from '../../components/usePopover'

export interface Opt { value: string; label: string; hint?: string }

interface Props {
  label: string
  value: string
  /** What to show for the current value (it may not be in `options`, e.g. a dealer found by an earlier search). */
  selectedLabel?: string
  options: Opt[]
  onChange: (value: string, label: string) => void
  /** Set when `options` come from the server: called with the typed text (after a pause) instead of filtering locally. */
  onQuery?: (q: string) => void
  allLabel?: string
  placeholder?: string
}

/** A dropdown with a search box. The list always opens below the field, shows every match, and is fully keyboard driven. */
export default function SearchSelect({ label, value, selectedLabel, options, onChange, onQuery, allLabel = 'All', placeholder = 'Search…' }: Props) {
  const { open, setOpen, ref } = usePopover()
  const id = useId()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const typed = useDebounced(q, 250)

  useEffect(() => { if (open && onQuery) onQuery(typed) }, [open, typed, onQuery])
  useEffect(() => { if (open) input.current?.focus() }, [open])

  const needle = q.trim().toLowerCase()
  const shown = onQuery ? options : options.filter((o) => o.label.toLowerCase().includes(needle))
  const items: Opt[] = [{ value: '', label: allLabel }, ...shown]
  const current = value ? (selectedLabel ?? options.find((o) => o.value === value)?.label ?? value) : allLabel

  const pick = (o: Opt) => { onChange(o.value, o.label); setOpen(false); setQ(''); setActive(0) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) pick(items[active]) }
  }

  return (
    <div ref={ref} className="relative flex flex-col gap-1 text-xs font-medium text-slate-600">
      <label id={`${id}-l`} htmlFor={`${id}-b`}>{label}</label>
      <div className="relative">
        <button type="button" data-trigger aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-l ${id}-b`} id={`${id}-b`}
          onClick={() => { setOpen(!open); setActive(0) }}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 pr-8 text-left text-sm font-normal text-slate-900 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
          <span className={`truncate ${value ? '' : 'text-slate-500'}`}>{current}</span>
          {!value && <ChevronDown aria-hidden className={`size-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />}
        </button>
        {value && (
          <button type="button" aria-label={`Clear ${label}`} onClick={() => onChange('', '')}
            className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"><X size={14} aria-hidden /></button>
        )}
      </div>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-sm rounded-lg border bg-white shadow-lg">
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} onKeyDown={onKey} placeholder={placeholder} aria-label={`Search ${label}`}
            role="combobox" aria-expanded aria-controls={`${id}-list`} aria-activedescendant={`${id}-o${active}`}
            className="h-10 w-full rounded-t-lg border-0 border-b bg-transparent px-3 text-sm font-normal outline-none" />
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
            {items.map((o, i) => (
              <li key={o.value || '__all'} id={`${id}-o${i}`} role="option" aria-selected={o.value === value}
                onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => pick(o)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-normal text-slate-900 ${i === active ? 'bg-primary-soft' : ''} ${o.value === value ? 'font-semibold text-primary' : ''}`}>
                <span className="min-w-0"><span className="block truncate">{o.label}</span>{o.hint && <span className="block truncate text-xs font-normal text-slate-500">{o.hint}</span>}</span>
                {o.value === value && <Check aria-hidden className="size-4 shrink-0" />}
              </li>
            ))}
            {shown.length === 0 && <li role="presentation" className="px-3 py-3 text-sm font-normal text-slate-500">{needle ? 'No matches.' : 'Nothing to choose.'}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
