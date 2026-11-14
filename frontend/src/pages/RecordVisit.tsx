import { useState } from 'react'
import { EMPTY_DRAFT } from '../visit/dealerDraft.ts'
import { notifyFollowupsChanged } from '../visit/followupBadge'
import StepDealer from '../visit/StepDealer'
import StepDone from '../visit/StepDone'
import StepOrder, { EMPTY_ORDER, type OrderState, type Saved } from '../visit/StepOrder'
import Stepper from '../visit/Stepper'
import type { Chosen, DealerState } from '../visit/types.ts'

const FRESH_DEALER: DealerState = { mode: 'scan', draft: EMPTY_DRAFT, selected: null, scan: { phase: 'idle' } }

/**
 * Record Visit, in three steps: 1 Dealer Details, 2 Order Details, 3 Done.
 * Both forms live here, so going Back never loses what was typed. The request id is created once per visit and
 * reused on every retry, which is what lets the server ignore a double tap or a resend after a dropped connection.
 */
export default function RecordVisit() {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [dealer, setDealer] = useState<DealerState>(FRESH_DEALER)
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [order, setOrder] = useState<OrderState>(EMPTY_ORDER)
  const [saved, setSaved] = useState<Saved | null>(null)

  const updateDealer = (p: Partial<DealerState> | ((s: DealerState) => Partial<DealerState>)) =>
    setDealer((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }))

  function go(next: 1 | 2 | 3) {
    setStep(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function again() {
    setRequestId(crypto.randomUUID())
    setDealer(FRESH_DEALER); setChosen(null); setOrder(EMPTY_ORDER); setSaved(null)
    go(1)
  }

  return (
    <div>
      <Stepper step={step} />
      {step === 1 && <StepDealer state={dealer} update={updateDealer} onContinue={(c) => { setChosen(c); go(2) }} />}
      {step === 2 && chosen && (
        <StepOrder chosen={chosen} order={order} setOrder={(f) => setOrder(f)} requestId={requestId}
          onBack={() => go(1)}
          onSaved={(r) => { setSaved(r); notifyFollowupsChanged(); go(3) }}
          onUseDealer={(d) => { setChosen({ kind: 'existing', dealer: d }); updateDealer({ mode: 'existing', selected: d }) }} />
      )}
      {step === 3 && saved && chosen && <StepDone saved={saved} newDealer={chosen.kind === 'new'} onAnother={again} />}
    </div>
  )
}
