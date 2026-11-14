import { Link, useLocation } from 'react-router-dom'
import { useFieldTracker } from '../field/useTracker'
import { trackingSummary } from '../field/summary'


const dot = { green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-slate-400' }
const box = {
  green: 'border-green-200 bg-green-50 text-green-900', amber: 'border-amber-200 bg-amber-50 text-amber-900',
  red: 'border-red-200 bg-red-50 text-red-900', gray: 'border-slate-200 bg-slate-50 text-slate-700',
}

/** Shown on every salesman page, so the tracking status is never out of sight. */
export default function DutyBanner({ userId }: { userId: number }) {
  const s = useFieldTracker(userId)
  const { pathname } = useLocation()
  if (pathname === '/field') return null // the Field page shows the full status card itself
  const { tone, text } = trackingSummary(s)
  const on = !!s.duty?.on_duty
  return (
    <div role="status" aria-live="polite" className={`mb-4 flex items-start gap-3 rounded-xl border px-3 py-2 text-sm ${box[tone]}`}>
      <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot[tone]} ${on && tone === 'green' ? 'animate-pulse' : ''}`} />
      <span className="flex-1">{text}</span>
      <Link to="/field" className="shrink-0 font-medium underline">{on || s.pendingEnd ? 'Manage' : 'Go on duty'}</Link>
    </div>
  )
}
