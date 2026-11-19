import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Me } from '../auth'
import { crumbsFor, useCrumbName } from './crumbs'
import { managementNav, salesmanNav, toneFor, toneStyle } from './nav'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import DutyTracker from './DutyTracker'
import BottomNav from './BottomNav'
import { useFollowupSummary } from '../visit/followupBadge'

const KEY = 'sm_sidebar_collapsed'
const readCollapsed = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches

/** Fixed left sidebar + sticky top bar + content. Below 1024px the sidebar is an off-canvas drawer. */
export default function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [drawer, setDrawer] = useState(false)
  const salesman = me.role === 'salesman'
  const items = salesman ? salesmanNav : managementNav
  // One poll for the follow-up count, shared by the sidebar and the phone bottom bar. Nothing is requested for management.
  const followups = useFollowupSummary(items.some((i) => i.badge === 'followups'), pathname)

  const setCollapsedSaved = (v: boolean) => {
    setCollapsed(v)
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* storage unavailable: the preference just won't persist */ }
  }
  const toggle = () => (isDesktop() ? setCollapsedSaved(!collapsed) : setDrawer(!drawer))

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!drawer) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [drawer])

  // Tab title follows the page: "Dealers · Sales Master".
  const name = useCrumbName()
  const crumbs = crumbsFor(pathname, name)
  const page = crumbs.at(-1)?.label
  useEffect(() => { document.title = page ? `${page} · Sales Master` : 'Sales Master' }, [page])

  return (
    // The whole shell takes the current section's colour; the sidebar and bottom bar give each item its own.
    <div className="min-h-screen bg-white text-slate-900" style={toneStyle(toneFor(items, pathname))}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white">Skip to content</a>
      <Sidebar items={items} followups={followups} collapsed={collapsed} open={drawer} onNavigate={() => setDrawer(false)} onExpand={() => setCollapsedSaved(false)} />
      {drawer && <div aria-hidden className="fixed inset-0 z-30 bg-primary/40 lg:hidden" onClick={() => setDrawer(false)} />}
      <div className={`transition-[padding] duration-200 print:pl-0 ${collapsed ? 'lg:pl-16' : 'lg:pl-64'}`}>
        <TopBar me={me} onToggle={toggle} />
        {/* Salesman on a phone: leave room so the fixed bottom bar never covers the end of a page. */}
        <main id="main" tabIndex={-1} className={`mx-auto w-full max-w-[1440px] px-4 pt-6 outline-none sm:px-6 lg:px-8 ${salesman ? 'pb-24 lg:pb-6' : 'pb-6'}`}>
          {salesman && <DutyTracker userId={me.id} />}
          {children}
        </main>
      </div>
      {salesman && <BottomNav items={items} followups={followups} />}
    </div>
  )
}
