import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, CalendarX, CircleCheck, Clock, Store, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, type Me } from '../auth'
import { usePopover } from './usePopover'
import { Button } from './ui'

interface Alert { id: string; icon: LucideIcon; title: string; hint: string; count: number; to: string; tone: 'red' | 'amber' }
interface MgmtDash { overdue_followups: number; unassigned_dealers: number; no_recent_visit: number }
interface SalesmanFollowups { counts: { overdue: number; due_today: number } }

const REFRESH_MS = 5 * 60_000
const seenKey = (me: Me) => `sm_alerts_seen_${me.id}`
const readSeen = (me: Me) => { try { return localStorage.getItem(seenKey(me)) ?? '' } catch { return '' } }

/**
 * "Needs attention" for the signed-in user, built from the same live counts the pages use.
 * There is no notifications table, so "new" means the counts changed since this menu was last opened on this device.
 */
export default function AlertsMenu({ me }: { me: Me }) {
  const { open, setOpen, ref } = usePopover()
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [seen, setSeen] = useState(() => readSeen(me))
  const salesman = me.role === 'salesman'

  const load = useCallback(() => {
    const done = (a: Alert[]) => { setAlerts(a.filter((x) => x.count > 0)); setFailed(false) }
    if (salesman) {
      api<SalesmanFollowups>('/api/salesman/followups/?tab=pending').then((r) => done([
        { id: 'overdue', icon: CalendarX, title: 'Overdue follow-ups', hint: 'Past their due date and still pending', count: r.counts.overdue, to: '/followups', tone: 'red' },
        { id: 'today', icon: Clock, title: 'Follow-ups due today', hint: 'Waiting for you today', count: r.counts.due_today, to: '/followups', tone: 'amber' },
      ])).catch(() => setFailed(true))
    } else {
      api<MgmtDash>('/api/management/dashboard/').then((r) => done([
        { id: 'overdue', icon: CalendarX, title: 'Overdue follow-ups', hint: 'Past their due date and still pending', count: r.overdue_followups, to: '/followups-management?tab=overdue', tone: 'red' },
        { id: 'unassigned', icon: UserX, title: 'Unassigned dealers', hint: 'No current owning salesman', count: r.unassigned_dealers, to: '/dealers?assignment=unassigned', tone: 'amber' },
        { id: 'stale', icon: Store, title: 'Dealers with no recent visit', hint: 'No visit in the last 30 days', count: r.no_recent_visit, to: '/dealers?visit=stale', tone: 'amber' },
      ])).catch(() => setFailed(true))
    }
  }, [salesman])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const signature = (alerts ?? []).map((a) => `${a.id}:${a.count}`).join('|')
  const unread = signature !== '' && signature !== seen
  const total = (alerts ?? []).reduce((n, a) => n + a.count, 0)

  function toggle() {
    if (!open) {
      load()
      try { localStorage.setItem(seenKey(me), signature) } catch { /* private mode: the dot just reappears next time */ }
      setSeen(signature)
    }
    setOpen(!open)
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" data-trigger onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
        aria-label={unread ? `Alerts, ${total} items need attention, changed since you last looked` : total ? `Alerts, ${total} items need attention` : 'Alerts'}
        className="relative grid size-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100">
        <Bell size={18} aria-hidden />
        {unread && <span aria-hidden className="absolute right-2.5 top-2.5 size-2.5 rounded-full bg-accent ring-2 ring-white" />}
      </button>
      {open && (
        <div role="dialog" aria-label="Alerts" className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-white shadow-pop">
          <div className="border-b px-4 py-3"><p className="text-sm font-semibold text-slate-900">Needs attention</p></div>
          {failed && !alerts && (
            <div role="alert" className="px-4 py-6 text-center text-sm text-red-600">Could not load alerts.<div className="mt-3"><Button size="sm" variant="secondary" onClick={load}>Try again</Button></div></div>
          )}
          {!failed && !alerts && <p role="status" className="px-4 py-6 text-center text-sm text-slate-500">Loading…</p>}
          {alerts?.length === 0 && (
            <div className="flex flex-col items-center px-4 py-8 text-center"><CircleCheck size={24} className="mb-2 text-green-600" aria-hidden /><p className="text-sm font-medium text-slate-900">You’re all caught up</p><p className="mt-1 text-xs text-slate-500">Nothing is overdue or unassigned right now.</p></div>
          )}
          {alerts && alerts.length > 0 && (
            <ul className="p-1">
              {alerts.map((a) => (
                <li key={a.id}>
                  <Link to={a.to} onClick={() => setOpen(false)} className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-50">
                    <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${a.tone === 'red' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}><a.icon size={16} aria-hidden /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-900">{a.title}</span><span className="block text-xs text-slate-500">{a.hint}</span></span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${a.tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>{a.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t px-4 py-2 text-[11px] text-slate-500">Live counts. The dot appears when they change.</p>
        </div>
      )}
    </div>
  )
}
