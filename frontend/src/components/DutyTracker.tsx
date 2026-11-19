import { useFieldTracker } from '../field/useTracker'

/**
 * Starts duty as soon as a salesman opens the app and keeps recording across every page.
 * Renders nothing: there is no on-screen duty message.
 */
export default function DutyTracker({ userId }: { userId: number }) {
  useFieldTracker(userId)
  return null
}
