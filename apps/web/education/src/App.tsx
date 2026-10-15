/** Authenticated shell with four primary business entries and owner-private snapshots. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import type { Profile, Work, WorkId, WorkspaceView } from '@deepseek-ai/dsh-experimental-education-workbench/types'
import { ApiError, client } from './client.ts'
import { ErrorNotice, errorText, Login, ProfileForm } from './forms.tsx'
import { Dashboard, Knowledge } from './pages.tsx'
import { Studio } from './Studio.tsx'
import { zh } from './locales.ts'

type Panel = 'dashboard' | 'analysis' | 'knowledge' | 'studio'

/** @returns the private content-operations application. */
export function App() {
  const [phase, setPhase] = useState<'loading' | 'login' | 'ready' | 'error'>('loading')
  const [data, setData] = useState<WorkspaceView | null>(null)
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [panel, setPanel] = useState<Panel>('studio')
  const [selected, setSelected] = useState<WorkId | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [seedTopic, setSeedTopic] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const onDirty = useCallback((value: boolean) => setDirty(value), [])

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setData(null); setSelected(null); setDirty(false); setProfileOpen(false); setPhase('login') }
      throw error
    }
  }
  async function load() {
    const next = await guarded(() => client.load())
    setData(next); setPhase('ready'); setError(null)
  }
  useEffect(() => {
    let alive = true
    void client.setup().then(value => { if (alive) setRegistrationOpen(value.registrationOpen) }).catch(error => { if (alive) setError(errorText(error)) })
    void client.load().then(next => { if (alive) { setData(next); setPhase('ready') } }).catch(error => { if (alive) { if (error instanceof ApiError && error.status === 401) setPhase('login'); else { setError(errorText(error)); setPhase('error') } } })
    const preference = localStorage.getItem('education-theme')
    document.body.toggleAttribute('data-ds-dark-theme', preference === 'dark' || (!preference && matchMedia('(prefers-color-scheme: dark)').matches))
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    if (!data?.runningWorkIds.length || busy) return
    const timer = setInterval(() => { void load().catch(error => setError(errorText(error))) }, 2000)
    return () => clearInterval(timer)
  }, [data?.runningWorkIds.length, busy])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer) }, [notice])

  function canLeave(): boolean { return !dirty || window.confirm(zh.discard) }
  function selectPanel(next: Panel) { if (busy || !canLeave()) return; setDirty(false); setPanel(next); setProfileOpen(false); setError(null); if (next === 'analysis' && data?.works.find(work => work.id === selected)?.kind !== 'analysis') setSelected(null); if (next === 'studio' && data?.works.find(work => work.id === selected)?.kind === 'analysis') setSelected(null) }
  function selectWork(id: WorkId | null) { if (!canLeave()) return; setDirty(false); setSelected(id); setSeedTopic('') }
  function toggleTheme() { const dark = !document.body.hasAttribute('data-ds-dark-theme'); document.body.toggleAttribute('data-ds-dark-theme', dark); localStorage.setItem('education-theme', dark ? 'dark' : 'light') }
  async function logout() {
    if (busy || !canLeave()) return
    try { await guarded(() => client.logout()); setData(null); setSelected(null); setDirty(false); setProfileOpen(false); setPhase('login') } catch (error) { setError(errorText(error)) }
  }
  async function create(input: object) { const result = await guarded(() => client.create(input)); setData(result.workspace); setSelected(result.work.id); setSeedTopic(''); setDirty(false) }
  async function save(work: Work, title: string, content: string): Promise<Work> { const result = await guarded(() => client.save(work.id, work.revision, title, content)); setData(result.workspace); setDirty(false); setNotice(zh.saved); return result.work }
  async function generate(work: Work, instruction: string) {
    setBusy(true); setError(null)
    try { const result = await guarded(() => client.generate(work.id, work.revision, instruction, crypto.randomUUID())); setData(result.workspace); setNotice(zh.saved) }
    catch (error) { try { await load() } catch (refreshError) { setError(errorText(refreshError)) }; throw error }
    finally { setBusy(false) }
  }
  async function saveProfile(profile: Profile) { const next = await guarded(() => client.profile(profile)); setData(next); setNotice(zh.profileSaved) }
  async function refresh() { if (!canLeave()) return; setDirty(false); setSelected(null); await load() }

  if (phase === 'loading') return <main className="loading" role="status">{zh.loading}</main>
  if (phase === 'error') return <main className="loading"><ErrorNotice error={error} /><Button variant="primary" onClick={() => void load().catch(error => setError(errorText(error)))}>{zh.retry}</Button></main>
  if (phase === 'login' || !data) return <Login registrationOpen={registrationOpen} onLogin={async () => { await load(); setPanel('studio'); setSelected(null) }} />
  const work = data.works.find(work => work.id === selected) ?? null
  return <div className="app-shell">
    <aside className="primary-sidebar"><div className="brand"><div className="brand-symbol" aria-hidden="true">H</div><strong>{zh.title}</strong></div><p className="sidebar-subtitle">{zh.subtitle}</p>
      <nav aria-label={zh.title}>{(['dashboard', 'analysis', 'knowledge', 'studio'] as const).map(id => <button key={id} className={`nav-item ${panel === id ? 'active' : ''}`} aria-current={panel === id && !profileOpen ? 'page' : undefined} onClick={() => selectPanel(id)} disabled={busy}><NavIcon panel={id} /><span>{zh[id]}</span></button>)}</nav>
      <div className="sidebar-footer"><span className="private-dot" aria-hidden="true" /><span>{zh.private}</span></div>
    </aside>
    <div className="workspace"><header className="app-header"><span>{data.profile?.displayName ?? data.member.username}</span><div className="header-actions"><Button onClick={() => { if (busy || !canLeave()) return; setDirty(false); setProfileOpen(!profileOpen) }} disabled={busy}>{zh.profile}</Button><Button onClick={toggleTheme} aria-label={zh.theme}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4v16a8 8 0 0 0 0-16Z" fill="currentColor" /></svg></Button><Button onClick={() => void logout()} disabled={busy}>{zh.logout}</Button></div></header>
      <div className="workspace-content"><ErrorNotice error={error} />{profileOpen ? <ProfileForm profile={data.profile} onSave={saveProfile} onClose={() => setProfileOpen(false)} /> : panel === 'knowledge' ? <Knowledge data={data} onData={setData} onNotice={setNotice} /> : panel === 'dashboard' ? <Dashboard data={data} onData={setData} onNotice={setNotice} onTopic={topic => { setPanel('studio'); setSelected(null); setSeedTopic(topic) }} /> : <Studio data={data} work={work} analysis={panel === 'analysis'} seedTopic={seedTopic} busy={busy} onSelect={selectWork} onCreate={create} onSave={save} onGenerate={generate} onCancel={id => guarded(() => client.cancel(id)).then(() => {})} onDirty={onDirty} onProfile={() => setProfileOpen(true)} onRefresh={refresh} onNotice={setNotice} />}</div>
    </div>{notice && <div className="toast" role="status">{notice}</div>}
  </div>
}

function NavIcon({ panel }: { panel: Panel }) {
  const paths: Record<Panel, string> = { dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', analysis: 'M4 4h16v16H4z M9 4v16 M9 10h11 M13 14h4 M13 17h4', knowledge: 'M3 5c4-2 7-1 9 1 2-2 5-3 9-1v15c-4-2-7-1-9 1-2-2-5-3-9-1z M12 6v15', studio: 'm4 20 4-1L20 7l-3-3L5 16z M14 7l3 3 M3 21h18' }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d={paths[panel]} /></svg>
}
