/** Editable saved works and dialogue; dirty text survives failed writes. */
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
import type { Work, WorkId, WorkKind, WorkspaceView } from '@deepseek-ai/dsh-experimental-education-workbench/types'
import { ErrorNotice, errorText, Field } from './forms.tsx'
import { time } from './pages.tsx'
import { zh } from './locales.ts'

interface StudioProps {
  data: WorkspaceView
  work: Work | null
  analysis: boolean
  seedTopic: string
  busy: boolean
  onSelect: (id: WorkId | null) => void
  onCreate: (input: object) => Promise<void>
  onSave: (work: Work, title: string, content: string) => Promise<Work>
  onGenerate: (work: Work, instruction: string) => Promise<void>
  onCancel: (id: WorkId) => Promise<void>
  onDirty: (dirty: boolean) => void
  onProfile: () => void
  onRefresh: () => Promise<void>
  onNotice: (text: string) => void
}

/** @param props - owned work data and commands. @returns the private creation workspace. */
export function Studio(props: StudioProps) {
  const works = props.data.works.filter(work => props.analysis ? work.kind === 'analysis' : work.kind !== 'analysis')
  return <section className="studio-shell">
    <aside className="work-list" aria-label={zh.works}><div className="section-heading"><h2>{zh.works}</h2><Button variant="outline" disabled={props.busy} onClick={() => props.onSelect(null)}>{props.analysis ? zh.newAnalysis : zh.newWork}</Button></div>
      {!works.length && <p className="muted">{zh.noWorks}</p>}
      {works.map(work => <button key={work.id} className={`work-item ${work.id === props.work?.id ? 'selected' : ''}`} disabled={props.busy} onClick={() => props.onSelect(work.id)}>
        <strong>{work.title}</strong><span>{kindLabel(work.kind)} · {time(work.updatedAt)}</span>
      </button>)}
    </aside>
    {props.work ? <Editor key={props.work.id} {...props} work={props.work} /> : <NewWork key={`${props.analysis}:${props.seedTopic}`} {...props} />}
  </section>
}

function NewWork(props: StudioProps) {
  const [kind, setKind] = useState<WorkKind>(props.analysis ? 'analysis' : 'script')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(null)
    try { await props.onCreate({ title: form.get('title'), topic: form.get('topic'), kind, sourceIds: form.getAll('sourceIds') }) } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="new-work page-content"><h1>{props.analysis ? zh.analysis : zh.studio}</h1><p className="muted">{props.analysis ? zh.analysisHint : zh.newWorkHint}</p>
    {!props.data.profile && <div className="profile-prompt"><span>{zh.profileNeeded}</span><Button variant="outline" onClick={props.onProfile}>{zh.profile}</Button></div>}
    <form className="card" onSubmit={event => void submit(event)}>
      {!props.analysis && <Field label={zh.workKind}><select value={kind} onChange={event => setKind(event.target.value === 'moments' ? 'moments' : 'script')} disabled={busy}><option value="script">{zh.script}</option><option value="moments">{zh.moments}</option></select></Field>}
      <Field label={zh.workTitle}><Input name="title" required maxLength={200} defaultValue={props.seedTopic.slice(0, 200)} disabled={busy} /></Field>
      <Field label={props.analysis ? zh.analysisOriginal : zh.topic}><textarea name="topic" required maxLength={20000} rows={props.analysis ? 9 : 5} defaultValue={props.seedTopic} disabled={busy} /></Field>
      <fieldset><legend>{zh.selectedSources}</legend>{props.data.materials.filter(material => material.authorized).map(material => <label className="check-row" key={material.id}><input name="sourceIds" type="checkbox" value={material.id} disabled={busy} />{material.title}</label>)}{!props.data.materials.some(material => material.authorized) && <p className="muted">{zh.noSources}</p>}</fieldset>
      <ErrorNotice error={error} /><Button variant="primary" type="submit" disabled={busy}>{busy ? zh.working : zh.createWork}</Button>
    </form>
  </div>
}

function Editor(props: StudioProps & { work: Work }) {
  const { work } = props
  const [title, setTitle] = useState(work.title)
  const [content, setContent] = useState(work.content)
  const [baseline, setBaseline] = useState({ title: work.title, content: work.content })
  const [instruction, setInstruction] = useState(work.dialogue.length ? '' : defaultInstruction(work.kind))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = title !== baseline.title || content !== baseline.content
  const busy = props.busy || saving
  const running = props.data.runningWorkIds.includes(work.id)

  useEffect(() => { props.onDirty(dirty); return () => props.onDirty(false) }, [dirty, props.onDirty])
  useEffect(() => {
    if (!dirty || (title === work.title && content === work.content)) {
      setBaseline({ title: work.title, content: work.content }); setTitle(work.title); setContent(work.content)
    }
  }, [work.revision])

  async function save(): Promise<Work> {
    setSaving(true); setError(null)
    try { return await props.onSave(work, title, content) } catch (error) { setError(errorText(error)); throw error } finally { setSaving(false) }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      const current = dirty ? await save() : work
      await props.onGenerate(current, instruction)
      setInstruction('')
    } catch (error) { setError(errorText(error)) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(content); props.onNotice(zh.copied) } catch { setError(zh.copyFailed) }
  }
  function exportWork() {
    if (dirty) { setError(zh.saveBeforeExport); return }
    const url = URL.createObjectURL(new Blob([`${work.title}\n\n${work.content}`], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `${work.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'content'}.txt`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="editor-layout"><section className="editor-panel" aria-label={zh.editor}>
    <div className="section-heading"><h1>{kindLabel(work.kind)}</h1><span className={dirty ? 'unsaved' : 'status-pill'} role="status">{dirty ? zh.unsaved : `${zh.saved} · ${time(work.updatedAt)}`}</span></div>
    <p className="muted small">{zh.editorHint}</p>
    <Field label={zh.workTitle}><Input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} disabled={busy || running} /></Field>
    <Field label={zh.editor}><textarea className="script-editor" value={content} onChange={event => setContent(event.target.value)} maxLength={60000} rows={18} placeholder={zh.emptyContent} disabled={busy || running} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (dirty && !busy && !running) void save().catch(() => {}) } }} /></Field>
    <ErrorNotice error={error ?? work.lastError} />
    <div className="editor-actions"><Button variant="primary" disabled={!dirty || busy || running || !title.trim()} onClick={() => void save().catch(() => {})}>{saving ? zh.working : zh.save}</Button><Button variant="outline" disabled={!content || busy || running} onClick={() => void copy()}>{zh.copy}</Button><Button variant="outline" disabled={!work.content || dirty || busy || running} onClick={exportWork}>{zh.export}</Button><Button disabled={busy || running} onClick={() => void props.onRefresh().catch(error => setError(errorText(error)))}>{zh.refreshWork}</Button></div>
  </section><section className="dialogue-panel" aria-label={zh.dialogue}>
    <h2>{zh.dialogue}</h2><div className="source-summary"><span className="small muted">{zh.selectedSources}</span><p>{work.sourceIds.map(id => props.data.materials.find(material => material.id === id)?.title ?? id).join(' · ') || zh.noSources}</p></div>
    <div className="dialogue-history" aria-live="polite">{!work.dialogue.length && <p className="muted">{zh.noDialogue}</p>}{work.dialogue.map((row, index) => <article className={`dialogue-message ${row.role}`} key={`${row.requestId}:${row.role}:${index}`}><strong>{row.role === 'user' ? zh.you : zh.assistant}</strong><div>{row.text}</div></article>)}{(props.busy || running) && <p className="generating" role="status">{zh.generating}</p>}</div>
    <form className="dialogue-form" onSubmit={event => void send(event)}><Field label={zh.instruction}><textarea value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={10000} rows={4} required disabled={busy || running} /></Field><Button variant="primary" type="submit" disabled={busy || running || !instruction.trim() || !props.data.profile}>{zh.send}</Button>{(props.busy || running) && <Button variant="outline" onClick={() => void props.onCancel(work.id).catch(error => setError(errorText(error)))}>{zh.stopping}</Button>}</form>
  </section></div>
}

function kindLabel(kind: WorkKind): string { return { script: zh.script, moments: zh.moments, analysis: zh.analysisKind }[kind] }
function defaultInstruction(kind: WorkKind): string { return { script: zh.defaultScript, moments: zh.defaultMoments, analysis: zh.defaultAnalysis }[kind] }
