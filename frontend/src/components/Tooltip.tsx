import { useId, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover/focus tooltip rendered in a portal, so it is never clipped by a scrolling sidebar or a transformed
 * drawer. Wraps one focusable child; screen readers get it through aria-describedby on the wrapper.
 */
export default function Tooltip({ text, children, disabled }: { text: string; children: React.ReactNode; disabled?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const id = useId()
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setPos({ x: r.right + 8, y: r.top + r.height / 2 })
  }
  return (
    <span className="block" aria-describedby={pos && !disabled ? id : undefined}
      onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setPos(null)}
      onFocus={(e) => show(e.currentTarget)} onBlur={() => setPos(null)}
      onKeyDown={(e) => e.key === 'Escape' && setPos(null)}>
      {children}
      {pos && !disabled && createPortal(
        <div id={id} role="tooltip" style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateY(-50%)' }}
          className="pointer-events-none z-[70] max-w-[16rem] rounded-lg bg-primary px-3 py-2 text-xs font-medium leading-snug text-white shadow-pop">
          {text}
        </div>,
        document.body,
      )}
    </span>
  )
}
