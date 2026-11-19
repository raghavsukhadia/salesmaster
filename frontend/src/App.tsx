import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { CircleAlert, Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { fetchMe, homeFor, isLoggedIn, login, type Me, type Role } from './auth'
import AppShell from './components/AppShell'
import { Button, Card, Field, PageHeader, UiProvider } from './components/ui'
import RecordVisit from './pages/RecordVisit'
import VisitHistory from './pages/VisitHistory'
import VisitDetail from './pages/VisitDetail'
import Followups from './pages/Followups'
import Dashboard from './pages/management/Dashboard'
import Dealers from './pages/management/Dealers'
import MyDealers from './pages/MyDealers'
import DealerDetail from './pages/management/DealerDetail'
import Salesmen from './pages/management/Salesmen'
import Products from './pages/management/Products'
import OwnershipCleanup from './pages/management/OwnershipCleanup'
import AccessGrants from './pages/management/AccessGrants'
import TransferDealers from './pages/management/TransferDealers'
import SalesmanDetail from './pages/management/SalesmanDetail'
import Visits from './pages/management/Visits'
import FollowupsManagement from './pages/management/FollowupsManagement'
import VisitView from './pages/management/VisitView'
import FollowupView from './pages/management/FollowupView'
import Settings from './pages/Settings'
import { isEnabledReport } from './pages/reports/reportNav'
// Leaflet is only needed on these two pages, so salesmen's phones never download it.
const FieldMap = lazy(() => import('./pages/management/FieldMap'))
const DealerLocations = lazy(() => import('./pages/management/DealerLocations'))
// Reports are only downloaded when someone opens them.
const ReportsLayout = lazy(() => import('./pages/reports/ReportsLayout'))
const ReportPage = lazy(() => import('./pages/reports/ReportPage'))
const ComparePage = lazy(() => import('./pages/reports/ComparePage'))

function Login() {
  const nav = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [show, setShow] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      await login(String(f.get('username')).trim(), String(f.get('password')))
      const me = await fetchMe()
      nav(homeFor(me.role), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <img src="/logo-trimmed.png" alt="Sales Master" width={638} height={439} className="mx-auto h-36 w-auto" />
        <Card className="mt-6 p-6 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sign in</h1>
          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />{error}
              </p>
            )}
            <Field label="Username or email">{(p) => <input {...p} name="username" required autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} />}</Field>
            <Field label="Password">
              {(p) => (
                <div className="relative">
                  <input {...p} name="password" type={show ? 'text' : 'password'} required autoComplete="current-password" className={`${p.className} pr-10`} />
                  <button type="button" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}
                    className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                    {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </div>
              )}
            </Field>
            <Button type="submit" loading={busy} className="mt-2 w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </Card>
      </div>
    </main>
  )
}

/** Signs the user in (or bounces them), then renders the role's sidebar/top-bar shell around the child routes. */
function ShellGuard({ roles }: { roles: Role[] }) {
  const [me, setMe] = useState<Me | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isLoggedIn()) return setFailed(true)
    fetchMe().then(setMe).catch(() => setFailed(true))
  }, [])

  // One login page for everyone: a session that ended goes back to it, and the role decides where they land afterwards.
  if (failed) return <Navigate to="/login" replace />
  if (!me) return <div role="status" aria-label="Loading" className="grid min-h-screen place-items-center text-slate-400"><LoaderCircle className="animate-spin" size={28} aria-hidden /></div>
  if (!roles.includes(me.role)) return <Navigate to={homeFor(me.role)} replace />
  return (
    <AppShell me={me}>
      <Suspense fallback={<div role="status" aria-label="Loading" className="grid h-64 place-items-center text-slate-400"><LoaderCircle className="animate-spin" size={24} aria-hidden /></div>}>
        <Outlet context={{ me }} />
      </Suspense>
    </AppShell>
  )
}

/** Salesman screens print their own title; the shell supplies navigation and the account menu. */
function SalesmanPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={title} />
      {children}
    </div>
  )
}

const SALESMAN: Role[] = ['salesman']
const MANAGEMENT: Role[] = ['manager', 'admin']

export default function App() {
  return (
    <UiProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ShellGuard roles={SALESMAN} />}>
            <Route path="/my-dealers" element={<MyDealers />} />
            <Route path="/my-dealers/:id" element={<DealerDetail />} />
            <Route path="/record-visit" element={<SalesmanPage title="Record Visit"><RecordVisit /></SalesmanPage>} />
            <Route path="/visit-history" element={<SalesmanPage title="Visit History"><VisitHistory /></SalesmanPage>} />
            <Route path="/visit-history/:id" element={<SalesmanPage title="Visit Details"><VisitDetail /></SalesmanPage>} />
            <Route path="/followups" element={<SalesmanPage title="Follow-ups"><Followups /></SalesmanPage>} />
            <Route path="/field" element={<Navigate to="/record-visit" replace />} />
          </Route>
          <Route element={<ShellGuard roles={MANAGEMENT} />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dealers" element={<Dealers />} />
            <Route path="/dealers/ownership-cleanup" element={<OwnershipCleanup />} />
            <Route path="/dealers/access-grants" element={<AccessGrants />} />
            <Route path="/dealers/transfer" element={<TransferDealers />} />
            <Route path="/products" element={<Products />} />
            <Route path="/dealers/:id" element={<DealerDetail />} />
            <Route path="/salesmen" element={<Salesmen />} />
            <Route path="/salesmen/:id" element={<SalesmanDetail />} />
            <Route path="/visits" element={<Visits />} />
            <Route path="/visits/:id" element={<VisitView />} />
            <Route path="/followups-management" element={<FollowupsManagement />} />
            <Route path="/followups-management/:id" element={<FollowupView />} />
            <Route path="/field-map" element={<FieldMap key="tracking" />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/dealer-locations" element={<DealerLocations />} />
          </Route>
          {/* Reports are admin-panel only (admin + manager). A salesman who opens /reports is sent back to their own home. */}
          <Route element={<ShellGuard roles={MANAGEMENT} />}>
            <Route path="/reports" element={<ReportsLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              {isEnabledReport('compare') && <Route path="compare" element={<ComparePage />} />}
              <Route path=":slug" element={<ReportPage />} />
              <Route path=":slug/:id" element={<ReportPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </UiProvider>
  )
}
