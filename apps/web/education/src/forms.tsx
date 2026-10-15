/** Login and personal-profile forms reuse the Harness button and input primitives. */
import { cloneElement, useId, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
import type { Profile } from '@deepseek-ai/dsh-experimental-education-workbench/types'
import { client } from './client.ts'
import { zh } from './locales.ts'

/** @param props - label and associated control. @returns a visibly labeled field. */
export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; hint?: string | undefined }) {
  const id = useId()
  return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>
}

/** @param props - public error text. @returns an announced, focus-independent error. */
export function ErrorNotice({ error }: { error: string | null }) { return error ? <div className="error" role="alert">{error}</div> : null }

/** @param error - async failure. @returns public failure text. */
export function errorText(error: unknown): string { return error instanceof Error ? error.message : zh.error }

/** @param props - signup availability and login result callback. @returns the member authentication form. */
export function Login({ registrationOpen, onLogin }: { registrationOpen: boolean; onLogin: () => Promise<void> }) {
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(null)
    try {
      await client.login({ username: form.get('username'), password: form.get('password'), invitationCode: form.get('invitationCode') ?? '' }, register)
      await onLogin()
    } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <main className="login-page"><div className="login-card">
    <div className="brand-symbol" aria-hidden="true">H</div><p className="eyebrow">{zh.title}</p>
    <h1>{register ? zh.register : zh.login}</h1><p className="muted">{zh.loginHint}</p>
    <form onSubmit={event => void submit(event)}>
      <Field label={zh.username} hint={zh.usernameHint}><Input name="username" autoComplete="username" required minLength={3} maxLength={32} disabled={busy} /></Field>
      <Field label={zh.password} hint={register ? zh.passwordHint : undefined}><Input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : 1} maxLength={200} disabled={busy} /></Field>
      {register && <Field label={zh.invitation}><Input name="invitationCode" type="password" autoComplete="off" required maxLength={200} disabled={busy} /></Field>}
      <ErrorNotice error={error} /><Button type="submit" variant="primary" disabled={busy}>{busy ? zh.working : register ? zh.joining : zh.login}</Button>
    </form>
    {registrationOpen ? <Button className="join-link" disabled={busy} onClick={() => { setRegister(!register); setError(null) }}>{register ? zh.backLogin : zh.register}</Button> : <p className="muted">{zh.noRegistration}</p>}
  </div></main>
}

/** @param props - current private profile and commit callbacks. @returns a profile editor. */
export function ProfileForm({ profile, onSave, onClose }: { profile: Profile | null; onSave: (profile: Profile) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input: Profile = { displayName: String(data.get('displayName') ?? ''), role: String(data.get('role') ?? ''), institution: String(data.get('institution') ?? ''), audience: String(data.get('audience') ?? ''), voice: String(data.get('voice') ?? ''), facts: String(data.get('facts') ?? ''), forbiddenClaims: String(data.get('forbiddenClaims') ?? '') }
    setBusy(true); setError(null)
    try { await onSave(input); onClose() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <section className="profile-panel" aria-label={zh.profile}>
    <div className="section-heading"><h2>{zh.profile}</h2><Button onClick={onClose} disabled={busy}>{zh.close}</Button></div><p className="muted">{zh.profileHint}</p>
    <form onSubmit={event => void submit(event)} className="profile-grid">
      {(['displayName', 'role', 'institution', 'audience', 'voice', 'facts', 'forbiddenClaims'] as const).map(key => <Field key={key} label={zh.fields[key]}>
        {['displayName', 'role', 'institution'].includes(key) ? <Input name={key} defaultValue={profile?.[key] ?? ''} required={key !== 'institution'} maxLength={key === 'displayName' ? 80 : key === 'role' ? 100 : 200} disabled={busy} /> : <textarea name={key} defaultValue={profile?.[key] ?? ''} required={key === 'audience' || key === 'voice'} rows={key === 'facts' ? 4 : 3} maxLength={key === 'facts' ? 6000 : key === 'audience' ? 1000 : 3000} disabled={busy} />}
      </Field>)}
      <div className="form-footer"><ErrorNotice error={error} /><Button variant="primary" type="submit" disabled={busy}>{busy ? zh.working : zh.save}</Button></div>
    </form>
  </section>
}
