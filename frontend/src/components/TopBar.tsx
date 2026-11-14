import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, LogOut, PanelLeft } from 'lucide-react'
import { logout, type Me } from '../auth'
import AlertsMenu from './AlertsMenu'
import { crumbsFor, useCrumbName } from './crumbs'
import { DateRangeMenu } from './DateRange'
import GlobalSearch from './GlobalSearch'
import { RANGE_ROUTES } from './nav'
import { usePopover } from './usePopover'
import { tracker } from '../field/useTracker'
import { Badge, useConfirm } from './ui'

function Breadcrumbs() {
  const { pathname } = useLocation()
  const crumbs = crumbsFor(pathname, useCrumbName())
  if (!crumbs.length) return null
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={c.label} className={`flex min-w-0 items-center gap-1.5 ${last ? '' : 'hidden sm:flex'}`}>
              {i > 0 && <ChevronRight size={14} className="hidden shrink-0 text-slate-400 sm:block" aria-hidden />}
              {c.to && !last ? <Link to={c.to} className="rounded text-slate-500 hover:text-slate-900">{c.label}</Link>
                : <span aria-current={last ? 'page' : undefined} className={`truncate ${last ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{c.label}</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Two letters for the avatar: "Alice Rao" -> "AR", "bob" -> "BO". */
const initials = (me: Me) => {
  const words = (me.name || me.username).trim().split(/\s+/)
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}

/** Sign out, asking first if the salesman is still on duty. Salesmen land on their own sign-in page, everyone else on the main one. */
function useSignOut(me: Me) {
  const nav = useNavigate()
  const confirm = useConfirm()
  return async () => {
    if (tracker.getState().duty?.on_duty && !(await confirm({ title: 'You are still on duty', message: 'Signing out stops location recording on this phone. Your duty session stays open until you press End duty.', confirmLabel: 'Sign out anyway', danger: true }))) return
    logout()
    nav(me.role === 'salesman' ? '/salesman-login' : '/login', { replace: true })
  }
}

function ProfileMenu({ me }: { me: Me }) {
  const signOut = useSignOut(me)
  const { open, setOpen, ref } = usePopover()
  return (
    <div ref={ref} className="relative">
      <button type="button" data-trigger aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`Account menu for ${me.name}, ${me.designation}`}
        className="flex h-10 items-center gap-2 rounded-lg pl-1 pr-2 hover:bg-slate-100">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-white">{initials(me)}</span>
        {/* The signed-in person, always visible from tablet width up: name above, designation below. */}
        <span className="hidden min-w-0 max-w-[10rem] text-left leading-tight md:block" data-testid="header-identity">
          <span className="block truncate text-sm font-medium text-slate-800">{me.name}</span>
          <span className="block truncate text-xs text-slate-500">{me.designation}</span>
        </span>
        <ChevronDown size={14} className="hidden text-slate-400 sm:block" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-60 rounded-xl border bg-white p-1 shadow-pop">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-slate-900">{me.name}</p>
            {me.name !== me.username && <p className="truncate text-xs text-slate-500">@{me.username}</p>}
            <div className="mt-1"><Badge tone="blue">{me.designation}</Badge></div>
          </div>
          <div className="my-1 border-t" />
          <button type="button" role="menuitem" onClick={signOut}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-50"><LogOut size={16} aria-hidden />Sign out</button>
        </div>
      )}
    </div>
  )
}

/** A one-tap Sign out in the header for salesmen (on a phone the account menu is two taps away). */
function SignOutButton({ me }: { me: Me }) {
  const signOut = useSignOut(me)
  return (
    <button type="button" onClick={signOut} aria-label="Sign out"
      className="grid size-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 sm:inline-flex sm:w-auto sm:gap-2 sm:px-3 sm:text-sm sm:font-medium">
      <LogOut size={18} aria-hidden /><span className="hidden sm:inline">Sign out</span>
    </button>
  )
}

export default function TopBar({ me, onToggle }: { me: Me; onToggle: () => void }) {
  const { pathname } = useLocation()
  const management = me.role !== 'salesman'
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-8 print:hidden">
      <button type="button" onClick={onToggle} aria-label="Toggle navigation" aria-controls="primary-nav"
        className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100"><PanelLeft size={20} aria-hidden /></button>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {management && <GlobalSearch />}
        {management && RANGE_ROUTES.includes(pathname) && <DateRangeMenu />}
        <AlertsMenu me={me} />
        <ProfileMenu me={me} />
        {!management && <SignOutButton me={me} />}
      </div>
    </header>
  )
}
