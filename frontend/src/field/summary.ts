import type { TrackerState } from './fieldTracker.ts'

/** One honest sentence about whether the app is recording right now. Used by the banner and the Field page. */
const REJECT_TEXT: Record<string, string> = {
  outside_session: "the phone's clock may be wrong, or the reading is from before you went on duty",
  no_session: 'you are not on a duty session',
  accuracy_too_poor: 'GPS accuracy is too poor (try near a window or outdoors)',
  future_timestamp: "the phone's clock looks wrong",
  invalid_coordinates: 'the location reading was not valid',
}
export const rejectHint = (reasons: string[]): string => [...new Set(reasons)].map((r) => REJECT_TEXT[r] ?? r).join('; ') + '.'

export function trackingSummary(s: TrackerState): { tone: 'green' | 'amber' | 'red' | 'gray'; text: string } {
  if (!s.loaded) return { tone: 'gray', text: 'Checking duty status…' }
  if (s.pendingEnd) return { tone: 'amber', text: 'Duty ended on this phone. Recording has stopped; finishing with the server when you are online.' }
  if (!s.duty?.on_duty) return { tone: 'gray', text: 'Off duty. Your location is not being recorded.' }
  if (s.gps === 'denied') return { tone: 'red', text: 'On duty, but location access is blocked, so nothing is being recorded. Allow location for this site.' }
  if (s.gps === 'unsupported') return { tone: 'red', text: 'On duty, but this browser cannot provide GPS, so nothing is being recorded.' }
  if (s.gps === 'unavailable') return { tone: 'amber', text: 'On duty. GPS position is unavailable right now (check that Location is switched on).' }
  if (s.gps === 'waiting' || s.gps === 'timeout' || s.gps === 'idle') return { tone: 'amber', text: 'On duty. Waiting for a GPS position…' }
  if (!s.online || s.uploadProblem === 'offline') return { tone: 'amber', text: `On duty and recording. Offline: ${s.queued} point${s.queued === 1 ? '' : 's'} saved on this phone, will sync automatically.` }
  if (s.uploadProblem === 'server') return { tone: 'amber', text: `On duty and recording. The server is not accepting uploads right now; ${s.queued} point${s.queued === 1 ? '' : 's'} are saved and will retry.` }
  if (s.uploadProblem === 'auth') return { tone: 'red', text: 'On duty, but you have been signed out, so uploads are paused. Sign in again.' }
  if (s.lastRejected.length && s.serverStatus !== 'live') return { tone: 'amber', text: `On duty, but the server is not accepting your position yet: ${rejectHint(s.lastRejected)}` }
  if (s.serverStatus === 'stale' || s.serverStatus === 'lost') return { tone: 'amber', text: "On duty and recording, but the server's latest position for you is out of date." }
  if (s.serverStatus !== 'live') return { tone: 'amber', text: 'On duty and recording. Waiting for the server to confirm your position…' }
  return { tone: 'green', text: 'On duty. Your location is being shared with your managers.' }
}
