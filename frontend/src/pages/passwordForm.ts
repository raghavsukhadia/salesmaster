// The Settings > Change password form: what is checked before anything is sent. The server checks again (and also rejects
// common and too-similar passwords); these checks only exist so a typo is caught at the field, without a round trip.

/** Matches Django's MinimumLengthValidator default, which the server applies. */
export const MIN_PASSWORD = 8

export interface PasswordForm { current: string; next: string; confirm: string }
export type PasswordErrors = Partial<Record<keyof PasswordForm, string>>

export function validatePasswordChange(f: PasswordForm): PasswordErrors {
  const e: PasswordErrors = {}
  if (!f.current) e.current = 'Enter your current password'
  if (!f.next) e.next = 'Enter a new password'
  else if (f.next.length < MIN_PASSWORD) e.next = `Use at least ${MIN_PASSWORD} characters`
  else if (f.next === f.current) e.next = 'Choose a password different from your current one'
  if (!f.confirm) e.confirm = 'Type the new password again'
  else if (f.confirm !== f.next) e.confirm = 'The two passwords do not match'
  return e
}
