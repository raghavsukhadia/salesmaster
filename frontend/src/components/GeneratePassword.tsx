import { useState } from 'react'
import { Check, Copy, KeyRound } from 'lucide-react'
import { generatePassword } from '../credentials'
import { Button, useToast } from './ui'

/**
 * "Generate" and "Copy" for a password field. The caller shows the field as plain text once something is generated,
 * because the administrator has to read the password out or paste it to the salesman: it is not retrievable later.
 */
export default function GeneratePassword({ value, onGenerate }: { value: string; onGenerate: (password: string) => void }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access needs https or localhost; on a plain http address the password has to be selected and copied by hand.
      toast('Could not copy automatically. Select the password and copy it.', 'error')
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => { onGenerate(generatePassword()); setCopied(false) }}><KeyRound size={14} aria-hidden />Generate password</Button>
      <Button size="sm" variant="secondary" disabled={!value} onClick={copy}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  )
}
