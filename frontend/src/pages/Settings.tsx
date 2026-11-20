import { useState } from 'react'
import { ApiError, changePassword } from '../auth'
import { Button, Card, Field, fieldErrors, PageHeader, useToast } from '../components/ui'
import { validatePasswordChange, type PasswordErrors, type PasswordForm } from './passwordForm.ts'

const EMPTY: PasswordForm = { current: '', next: '', confirm: '' }

/** Settings has one option for now: change your own password. */
export default function Settings() {
  const toast = useToast()
  const [form, setForm] = useState<PasswordForm>(EMPTY)
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [note, setNote] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = (k: keyof PasswordForm, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
    setNote('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const bad = validatePasswordChange(form)
    if (Object.keys(bad).length) return setErrors(bad)
    setBusy(true); setNote('')
    try {
      await changePassword(form.current, form.next)
      setForm(EMPTY); setErrors({})
      toast('Password changed')
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const server = fieldErrors(err.data)
        if (server.current_password || server.new_password) setErrors({ current: server.current_password, next: server.new_password })
        else setNote('That password could not be accepted. Check it and try again.')
      } else if (err instanceof ApiError && err.status === 429) setNote('Too many attempts. Wait an hour, then try again.')
      else setNote('Could not change the password. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const type = show ? 'text' : 'password'
  return (
    <>
      <PageHeader title="Settings" />
      <Card className="max-w-lg p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Change password</h2>
        <p className="mt-0.5 text-sm text-slate-500">Use at least 8 characters.</p>
        <form onSubmit={submit} noValidate className="mt-5 space-y-4">
          {note && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{note}</p>}
          <Field label="Current password" error={errors.current}>
            {(p) => <input {...p} type={type} autoComplete="current-password" maxLength={128} value={form.current} onChange={(e) => set('current', e.target.value)} />}
          </Field>
          <Field label="New password" error={errors.next}>
            {(p) => <input {...p} type={type} autoComplete="new-password" maxLength={128} value={form.next} onChange={(e) => set('next', e.target.value)} />}
          </Field>
          <Field label="Confirm new password" error={errors.confirm}>
            {(p) => <input {...p} type={type} autoComplete="new-password" maxLength={128} value={form.confirm} onChange={(e) => set('confirm', e.target.value)} />}
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />Show passwords
          </label>
          <Button type="submit" loading={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
        </form>
      </Card>
    </>
  )
}
