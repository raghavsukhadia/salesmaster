import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CircleAlert, Eye, EyeOff, UserRound } from 'lucide-react'
import { fetchMe, homeFor, login, logout } from '../auth'
import { Button, Card, Field } from '../components/ui'

/**
 * The salesman's own sign-in page. It signs in the same way as the main page, but only lets a salesman account through:
 * an admin or manager who lands here is signed straight back out and pointed to the main page.
 */
export default function SalesmanLogin() {
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
      if (me.role !== 'salesman') {
        logout()
        setError('This page is for salesmen. Administrators and managers sign in on the main login page.')
        return
      }
      nav(homeFor(me.role), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <img src="/logo-trimmed.png" alt="Sales Master" width={638} height={439} className="mx-auto h-36 w-auto" />
        <Card className="mt-6 p-6 sm:p-8">
          <span className="grid size-10 place-items-center rounded-full bg-primary-soft text-primary"><UserRound size={20} aria-hidden /></span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-900">Salesman Login</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in with the username or email and password your administrator gave you.</p>
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
          <p className="mt-5 text-center text-xs text-slate-500">Forgot your password? Ask your administrator to reset it.</p>
        </Card>
        <p className="mt-4 text-center text-sm text-slate-500">Administrator or manager? <Link to="/login" className="font-medium text-primary hover:underline">Sign in here</Link></p>
      </div>
    </main>
  )
}
