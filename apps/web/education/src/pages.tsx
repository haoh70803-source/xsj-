/** Private knowledge and actual-data analytics pages. */
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
import type { ContentMetric, WorkspaceView } from '@deepseek-ai/dsh-experimental-education-workbench/types'
import { client } from './client.ts'
import { ErrorNotice, errorText, Field } from './forms.tsx'
import { zh } from './locales.ts'

interface PageProps { data: WorkspaceView; onData: (data: WorkspaceView) => void; onNotice: (text: string) => void }

/** @param value - server-confirmed ISO time. @returns a local display time. */
export function time(value: string): string { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', hour12: false }) }

/** @param props - authenticated material snapshot and commit callbacks. @returns private knowledge management. */
export function Knowledge({ data, onData, onNotice }: PageProps) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true); setError(null)
    try {
      onData(await client.material({ title: fields.get('title'), content: fields.get('content'), sourceUrl: fields.get('sourceUrl') ?? '', authorized: fields.get('authorized') === 'on' }))
      setAdding(false); onNotice(zh.materialSaved)
    } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  async function authorization(id: string, revision: number, authorized: boolean) {
    setBusy(true); setError(null)
    try { onData(await client.authorization(id, revision, authorized)) } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <section className="page-content"><div className="section-heading"><div><h1>{zh.knowledge}</h1><p className="muted">{zh.knowledgeHint}</p></div><Button variant="primary" onClick={() => setAdding(!adding)} disabled={busy}>{adding ? zh.cancel : zh.addMaterial}</Button></div>
    <ErrorNotice error={error} />
    {adding && <form className="card material-form" onSubmit={event => void submit(event)}>
      <Field label={zh.materialTitle}><Input name="title" required maxLength={200} disabled={busy} /></Field>
      <Field label={zh.sourceUrl} hint={zh.sourceHint}><Input name="sourceUrl" type="url" maxLength={2000} disabled={busy} /></Field>
      <Field label={zh.materialContent}><textarea name="content" required maxLength={20000} rows={8} disabled={busy} /></Field>
      <label className="check-row"><input name="authorized" type="checkbox" required disabled={busy} />{zh.authorized}</label>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? zh.working : zh.save}</Button>
    </form>}
    {!data.materials.length && !adding && <div className="empty-state">{zh.noMaterials}</div>}
    <div className="material-grid">{data.materials.map(material => <article className="card" key={material.id}>
      <div className="section-heading"><h2>{material.title}</h2><span className={material.authorized ? 'status-pill' : 'muted'}>{material.authorized ? zh.available : zh.revoked}</span></div>
      <p className="material-excerpt">{material.content.slice(0, 320)}</p>
      {material.sourceUrl && <a href={material.sourceUrl} target="_blank" rel="noopener noreferrer">{zh.openSource}</a>}
      <p className="small muted">{zh.updated} · {time(material.updatedAt)}</p>
      <Button variant="outline" disabled={busy} onClick={() => void authorization(material.id, material.revision, !material.authorized)}>{material.authorized ? zh.revoke : zh.restore}</Button>
    </article>)}</div>
  </section>
}

/** @param props - imported actual metrics and topic navigation. @returns account-specific median analysis. */
export function Dashboard({ data, onData, onNotice, onTopic }: PageProps & { onTopic: (topic: string) => void }) {
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState('')
  const accounts = data.accounts.filter(row => !account || JSON.stringify([row.platform, row.account]) === account)
  const rows = useMemo(() => accounts.flatMap(group => group.aboveMedian.map(row => ({ row, median: group.medianLikes }))).filter(({ row }) => `${row.title} ${row.keywords.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [data.accounts, account, query])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true); setError(null)
    try {
      let rows: unknown
      try { rows = JSON.parse(String(fields.get('rows') ?? '')) } catch { throw new Error(zh.invalidJson) }
      if (!Array.isArray(rows)) throw new Error(zh.invalidJson)
      const observedAt = new Date(String(fields.get('observedAt'))).toISOString()
      onData(await client.metrics({ rows, sourceLabel: fields.get('sourceLabel'), observedAt }))
      setImporting(false); onNotice(zh.metricsSaved)
    } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <section className="page-content"><div className="section-heading"><div><h1>{zh.dashboard}</h1><p className="muted">{zh.dashboardHint}</p></div><Button variant="primary" onClick={() => setImporting(!importing)} disabled={busy}>{importing ? zh.cancel : zh.importData}</Button></div>
    <ErrorNotice error={error} />
    {importing && <form className="card" onSubmit={event => void submit(event)}>
      <div className="two-columns"><Field label={zh.dataSource}><Input name="sourceLabel" required maxLength={200} disabled={busy} /></Field><Field label={zh.observedAt}><Input type="datetime-local" name="observedAt" required disabled={busy} /></Field></div>
      <Field label={zh.metricRows} hint={zh.dataHint}><textarea name="rows" required rows={9} disabled={busy} /></Field>
      <Button variant="primary" type="submit" disabled={busy}>{busy ? zh.working : zh.importData}</Button>
    </form>}
    {!data.metrics ? <div className="empty-state">{zh.noData}</div> : <>
      <div className="data-provenance"><span>{zh.source} · {data.metrics.sourceLabel}</span><span>{zh.observedAt} · {time(data.metrics.observedAt)}</span><span>{zh.importedAt} · {time(data.metrics.importedAt)}</span></div>
      <div className="filters"><Field label={zh.allAccounts}><select value={account} onChange={event => setAccount(event.target.value)}><option value="">{zh.allAccounts}</option>{data.accounts.map(row => <option key={JSON.stringify([row.platform, row.account])} value={JSON.stringify([row.platform, row.account])}>{zh.platform[row.platform]} · {row.account}</option>)}</select></Field><Field label={zh.keyword}><Input value={query} onChange={event => setQuery(event.target.value)} type="search" /></Field></div>
      <div className="account-grid">{accounts.map(group => <article className="card" key={JSON.stringify([group.platform, group.account])}><span className="muted">{zh.platform[group.platform]} · {group.account}</span><p className="metric-value">{group.medianLikes.toLocaleString()}</p><p>{zh.median}</p><div className="small muted">{zh.count} · {group.count} / {zh.aboveMedian} · {group.aboveMedian.length}</div></article>)}</div>
      <h2>{zh.aboveMedian}</h2>{!rows.length && <div className="empty-state">{zh.noMatches}</div>}
      <div className="metric-list">{rows.map(({ row, median }, index) => <MetricRow key={index} row={row} median={median} onTopic={onTopic} />)}</div>
    </>}
  </section>
}

function MetricRow({ row, median, onTopic }: { row: ContentMetric; median: number; onTopic: (topic: string) => void }) {
  return <article className="card metric-row"><div><span className="small muted">{zh.platform[row.platform]} · {row.account}</span><h3>{row.title}</h3><p className="small muted">{row.keywords.join(' · ')}</p></div><div><strong>{row.likes.toLocaleString()}</strong><p className="small muted">{zh.median} · {median.toLocaleString()}</p></div><div className="row-actions">{row.url && <a href={row.url} target="_blank" rel="noopener noreferrer">{zh.openSource}</a>}<Button variant="outline" onClick={() => onTopic(row.title)}>{zh.useTopic}</Button></div></article>
}
