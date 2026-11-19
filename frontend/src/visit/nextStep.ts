// "What should you do next?" on the Order details step: a required choice, and when it will happen.
// "Nothing" is a real answer: it records no follow-up, but the salesman has to say so.
import { localDate } from './format.ts'

export const NEXT_ACTIONS = [
  { value: 'nothing', label: 'Nothing' },
  { value: 'call_dealer', label: 'Call dealer' },
  { value: 'send_quotation', label: 'Send quotation' },
  { value: 'send_sample', label: 'Send sample' },
  { value: 'revisit_dealer', label: 'Revisit dealer' },
  { value: 'collect_payment', label: 'Collect payment' },
  { value: 'other', label: 'Other' },
] as const

export type NextAction = (typeof NEXT_ACTIONS)[number]['value']

export const WHEN_OPTIONS = [
  { value: 'tomorrow', label: 'Tomorrow', days: 1 },
  { value: 'in_2_days', label: 'In 2 Days', days: 2 },
  { value: 'next_week', label: 'Next Week', days: 7 },
  { value: 'custom', label: 'Custom', days: 0 },
] as const

export type When = (typeof WHEN_OPTIONS)[number]['value']

export interface NextStep {
  /** null until the salesman picks one: that is what makes it required. */
  action: NextAction | null
  when: When
  /** YYYY-MM-DD, only used when `when` is "custom". */
  customDate: string
  /** What to do, only used when the action is "other". */
  text: string
  note: string
}

export const EMPTY_NEXT_STEP: NextStep = { action: null, when: 'next_week', customDate: '', text: '', note: '' }

export const TEXT_MAX = 200
export const NOTE_MAX = 500
const MAX_DAYS_AHEAD = 365

/** The due date as YYYY-MM-DD. Worked out when asked, so a screen left open overnight never saves a date in the past. */
export function dueDateFor(s: Pick<NextStep, 'when' | 'customDate'>): string {
  if (s.when === 'custom') return s.customDate
  return localDate(WHEN_OPTIONS.find((o) => o.value === s.when)?.days ?? 0)
}

/** Everything the salesman still has to fix. Empty means the step is complete. */
export function nextStepProblems(s: NextStep): string[] {
  if (s.action === null) return ['Choose what you will do next, or choose “Nothing”.']
  if (s.action === 'nothing') return []
  const out: string[] = []
  if (s.action === 'other' && !s.text.trim()) out.push('Say what you will do.')
  if (s.when === 'custom') {
    if (!s.customDate) out.push('Choose a date for the follow-up.')
    else if (s.customDate < localDate()) out.push('The follow-up date cannot be in the past.')
    else if (s.customDate > localDate(MAX_DAYS_AHEAD)) out.push('Choose a date within the next year.')
  }
  return out
}

/** The follow-up to send with the visit, or null when the answer is "Nothing" (or nothing has been chosen). */
export function nextStepFollowup(s: NextStep): Record<string, string> | null {
  if (s.action === null || s.action === 'nothing') return null
  const note = s.note.trim()
  return {
    due_date: dueDateFor(s),
    action: s.action,
    ...(s.action === 'other' && { action_text: s.text.trim() }),
    ...(note && { notes: note }),
  }
}
