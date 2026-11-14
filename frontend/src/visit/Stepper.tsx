import { Check } from 'lucide-react'

export const STEPS = ['Dealer Details', 'Order Details', 'Done'] as const

/** Three-step progress indicator. `step` is 1-based. Completed steps show a tick, the current one is filled. */
export default function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Progress" className="mb-6">
      <ol className="flex items-start">
        {STEPS.map((label, i) => {
          const n = i + 1
          const done = n < step || step === 3 // once saved, every step is complete
          const current = n === step && step !== 3
          return (
            <li key={label} aria-current={current ? 'step' : undefined} className={`flex items-start ${i < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex w-20 flex-col items-center text-center sm:w-auto sm:flex-row sm:gap-3 sm:text-left">
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold transition-colors ${
                    done || current ? 'border-primary bg-primary text-white' : 'border-slate-300 bg-white text-slate-500'
                  }`}>
                  {done ? <Check size={18} strokeWidth={2.5} aria-hidden /> : n}
                </span>
                <span className={`mt-1.5 text-xs font-medium sm:mt-0 sm:text-sm ${done || current ? 'text-slate-900' : 'text-slate-500'}`}>
                  {label}
                  <span className="sr-only">{done ? ' (completed)' : current ? ' (current step)' : ''}</span>
                </span>
              </div>
              {i < STEPS.length - 1 && <span aria-hidden className={`mx-2 mt-[17px] h-0.5 flex-1 rounded ${n < step ? 'bg-primary' : 'bg-slate-200'}`} />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
