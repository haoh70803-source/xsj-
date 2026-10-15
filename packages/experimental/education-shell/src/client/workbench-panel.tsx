/** Native four-entry surface; rendering and ephemeral forms consume plain snapshots and callbacks. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AccountPermissions,
  ContentObservation,
  KnowledgeSearch,
  MetricFields,
  ResearchDocument,
  LegacyResearchDocument,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { StageSnapshot, StageWorkspace, WorkbenchEntry } from './stage-model.ts'
import { EducationPanel, type WorkspaceFace } from './panel.tsx'
import type { EducationKey } from './locales.ts'
import css from './panel.module.css'

/** Components receive only explicit actions; the model and service Context remain outside React. */
export type StageCommands = Pick<
  StageWorkspace,
  | 'navigate'
  | 'search'
  | 'selectSource'
  | 'useSource'
  | 'importSource'
  | 'importLegacy'
  | 'authorizeSource'
  | 'openResearch'
  | 'analyze'
  | 'cancelResearch'
  | 'saveResearch'
  | 'versions'
  | 'previewReport'
  | 'restoreReport'
  | 'exportResearch'
  | 'transferResearch'
  | 'accounts'
  | 'selectAccount'
  | 'createAccount'
  | 'queryAnalytics'
  | 'previewImport'
  | 'confirmImport'
  | 'grant'
  | 'enableAccount'
  | 'sync'
  | 'stopSync'
  | 'schedule'
  | 'exportAnalytics'
  | 'transferAnalytics'
  | 'resolve'
>
/** Existing writing face plus a second framework-owned observable. */
export interface WorkbenchFace extends WorkspaceFace {
  readonly hooks: WorkspaceFace['hooks'] & { readonly stageC: HostObservable<StageSnapshot> }
  readonly stage: StageCommands
}
type Props = PropsRuntime<'main'> & PropsLocale<'education'> & InjectFace<WorkbenchFace>
type T = PropsLocale<'education'>['t']
interface ContentProps {
  readonly state: StageSnapshot
  readonly actions: StageCommands
  readonly t: T
  readonly maxBytes: number
}
const entries: readonly WorkbenchEntry[] = ['knowledge', 'research', 'analytics', 'writing']

/** Keep the native writing editor mounted while other entries own their separate forms. */
export function WorkbenchPanel({ useStageC, stage, ...writing }: Props) {
  const state = useStageC(value => value),
    owner = writing.useEducation(value => value),
    t = writing.t
  return (
    <div className={css.workbench}>
      {owner.user && (
        <nav className={css.entries} aria-label={t('c.navigation')}>
          {entries.map(entry => (
            <Button
              key={entry}
              aria-current={state.entry === entry ? 'page' : undefined}
              onClick={() => {
                void stage.navigate(entry)
              }}
            >
              {t(`c.${entry}`)}
            </Button>
          ))}
        </nav>
      )}
      <div className={css.writingPane} hidden={owner.user !== null && state.entry !== 'writing'}>
        <EducationPanel {...writing} />
      </div>
      {owner.user && state.entry !== 'writing' && (
        <section
          key={`${owner.generation}:${state.epoch}`}
          className={css.panel}
          aria-label={t(`c.${state.entry}`)}
          aria-busy={state.busy || state.loading}
        >
          <header className={css.header}>
            <h1>{t(`c.${state.entry}`)}</h1>
            <span>{owner.user.username}</span>
          </header>
          <StageNotice state={state} actions={stage} t={t} />
          {state.entry === 'knowledge' && (
            <Knowledge state={state} actions={stage} t={t} maxBytes={writing.maxTextFileBytes} />
          )}
          {state.entry === 'research' && (
            <Research state={state} actions={stage} t={t} maxBytes={writing.maxTextFileBytes} />
          )}
          {state.entry === 'analytics' && (
            <Analytics
              key={state.accountId ?? 'none'}
              state={state}
              actions={stage}
              t={t}
              maxBytes={writing.maxTextFileBytes}
            />
          )}
        </section>
      )}
    </div>
  )
}
function StageNotice({ state, actions, t }: Omit<ContentProps, 'maxBytes'>) {
  const key =
    state.problem === 'education/QUOTA_EXCEEDED'
      ? 'c.quota'
      : state.problem === 'education/PROVIDER_PAUSED'
        ? 'c.paused'
        : state.problem === 'education/RESOURCE_UNAVAILABLE' || state.problem === 'education/UNAUTHENTICATED'
          ? 'c.restricted'
          : state.problem?.includes('CONFLICT')
            ? 'c.conflict'
            : 'c.failed'
  return (
    <>
      {state.problem && (
        <div className={css.notice} role="alert" tabIndex={-1}>
          {t(key)}
        </div>
      )}
      {state.uncertain && (
        <div className={css.notice} role="alert">
          <p>{t('c.uncertain')}</p>
          <Button
            disabled={state.busy}
            onClick={() => {
              void actions.resolve()
            }}
          >
            {t('check')}
          </Button>
          <Button
            disabled={state.busy}
            onClick={() => {
              void actions.resolve(true)
            }}
          >
            {t('retryOriginal')}
          </Button>
        </div>
      )}
      {state.notice && (
        <p role="status" aria-live="polite">
          {t(`c.${state.notice}`)}
        </p>
      )}
    </>
  )
}
function Knowledge({ state, actions, t, maxBytes }: ContentProps) {
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState<KnowledgeSearch['kind']>('all'),
    [composing, setComposing] = useState(false)
  const locked = state.busy || state.uncertain
  return (
    <div className={css.stageGrid}>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (!composing) void actions.search({ query, kind, limit: 20 })
        }}
      >
        <label>
          {t('c.query')}
          <Input
            value={query}
            onCompositionStart={() => {
              setComposing(true)
            }}
            onCompositionEnd={() => {
              setComposing(false)
            }}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </label>
        <label>
          {t('c.kind')}
          <select
            value={kind}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'all' || value === 'text' || value === 'transcript') setKind(value)
            }}
          >
            <option value="all">{t('c.all')}</option>
            <option value="text">{t('c.text')}</option>
            <option value="transcript">{t('c.transcript')}</option>
          </select>
        </label>
        <Button type="submit" disabled={locked || composing}>
          {t('c.search')}
        </Button>
      </form>
      {!state.knowledge.length && <p>{t('c.emptyKnowledge')}</p>}
      <ul>
        {state.knowledge.map(item => (
          <li key={item.versionId} className={css.sourceRow}>
            <strong>{item.title}</strong>
            <span>
              {t(`c.${item.kind}`)} · {item.revision}
            </span>
            <Button
              disabled={locked}
              onClick={() => {
                void actions.selectSource(item.versionId)
              }}
            >
              {t('c.select')}
            </Button>
            <Button
              disabled={locked || !item.canUseForAi || state.projectId === null}
              onClick={() => {
                void actions.useSource(item.versionId)
              }}
            >
              {t('c.useWriting')}
            </Button>
            <Button
              disabled={locked || !item.canUseForAi || state.projectId === null}
              onClick={() => {
                void (async () => {
                  await actions.selectSource(item.versionId)
                  await actions.navigate('research')
                })()
              }}
            >
              {t('c.useResearch')}
            </Button>
          </li>
        ))}
      </ul>
      {state.cursor && (
        <Button
          disabled={locked}
          onClick={() => {
            void actions.search({ query, kind, limit: 20 }, true)
          }}
        >
          {t('c.more')}
        </Button>
      )}
      {state.selectedSource && (
        <section className={css.manuscript}>
          <h2>
            {t('c.selected')}: {state.selectedSource.title}
          </h2>
          <p>{t('c.sourceHelp')}</p>
          <pre className={css.original}>{state.selectedSource.body}</pre>
          <Button
            disabled={locked}
            onClick={() => {
              void actions.authorizeSource(false)
            }}
          >
            {t('revoke')}
          </Button>
        </section>
      )}
      <SourceImport key={state.selectedSource?.versionId ?? 'new'} {...{ state, actions, t, maxBytes }} />
    </div>
  )
}
function SourceImport({ state, actions, t, maxBytes }: ContentProps) {
  const source = state.selectedSource,
    [edit, setEdit] = useState(false),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [url, setUrl] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [format, setFormat] = useState<'text' | 'research-input-v1'>('text'),
    [error, setError] = useState(false),
    [composing, setComposing] = useState(false)
  return (
    <details className={css.context}>
      <summary>{t('c.import')}</summary>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (confirmed && !composing) void actions.importSource({ format, title, content: body, sourceUrl: url, edit })
        }}
      >
        <p>{t('c.importHelp')}</p>
        {source && (
          <label className={css.check}>
            <input
              type="checkbox"
              checked={edit}
              onChange={(event) => {
                const checked = event.target.checked
                setEdit(checked)
                setTitle(checked ? source.title : '')
                setBody(checked ? source.body : '')
                setUrl(checked ? source.sourceUrl : '')
                setConfirmed(false)
              }}
            />
            {t('c.editSelected')}
          </label>
        )}
        <label>
          {t('c.format')}
          <select
            value={format}
            onChange={(event) => {
              setFormat(event.target.value === 'research-input-v1' ? 'research-input-v1' : 'text')
              setConfirmed(false)
            }}
          >
            <option value="text">{t('c.text')}</option>
            <option value="research-input-v1">{t('c.v1')}</option>
          </select>
        </label>
        <TextFile
          {...{ t, maxBytes }}
          accept=".txt,.md,.json"
          onText={(text, name) => {
            setBody(text)
            if (!title) setTitle(name)
            setConfirmed(false)
            setError(false)
          }}
          onError={() => {
            setError(true)
          }}
        />
        {error && <p role="alert">{t('c.fileError')}</p>}
        <label>
          {t('sourceTitle')}
          <Input
            required
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
              setConfirmed(false)
            }}
          />
        </label>
        <label>
          {t('sourceUrl')}
          <Input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setConfirmed(false)
            }}
          />
        </label>
        <label>
          {t('sourceBody')}
          <textarea
            required
            value={body}
            onCompositionStart={() => {
              setComposing(true)
            }}
            onCompositionEnd={() => {
              setComposing(false)
            }}
            onChange={(event) => {
              setBody(event.target.value)
              setConfirmed(false)
            }}
          />
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
          />
          {t('c.confirmSource')}
        </label>
        <Button type="submit" disabled={state.busy || state.uncertain || !confirmed || composing}>
          {t('c.import')}
        </Button>
      </form>
    </details>
  )
}
function Research({ state, actions, t, maxBytes }: ContentProps) {
  const [instruction, setInstruction] = useState(''),
    [restore, setRestore] = useState(false),
    [composing, setComposing] = useState(false)
  const selected = state.selectedSource,
    research = state.research,
    preview = state.reportPreview,
    document = preview?.document ?? research?.document ?? null
  const running = state.researchRun?.status === 'pending' || state.researchRun?.status === 'running',
    locked = state.busy || state.uncertain || running
  const canTransfer =
    !preview?.restricted && (preview !== null || research?.draft.bodyHash === research?.latestVersion?.bodyHash)
  return (
    <div className={css.stageGrid}>
      <p>{t('c.analysisHelp')}</p>
      {state.projectId === null && <p role="status">{t('c.projectRequired')}</p>}
      {selected ? (
        <p>
          {t('c.selected')}: {selected.title} · {selected.revision}
        </p>
      ) : (
        <p role="status">{t('c.sourceRequired')}</p>
      )}
      <Button
        disabled={locked}
        onClick={() => {
          void actions.navigate('knowledge')
        }}
      >
        {t('c.knowledge')}
      </Button>
      <label>
        {t('c.analysisInstruction')}
        <textarea
          value={instruction}
          disabled={locked}
          onCompositionStart={() => {
            setComposing(true)
          }}
          onCompositionEnd={() => {
            setComposing(false)
          }}
          onChange={(event) => {
            setInstruction(event.target.value)
          }}
        />
      </label>
      <div className={css.toolbar}>
        <Button
          disabled={locked || composing || !selected || !research || research.draft.restricted}
          onClick={() => {
            void actions.analyze(instruction)
          }}
        >
          {t('c.analyze')}
        </Button>
        {running && (
          <Button
            onClick={() => {
              void actions.cancelResearch()
            }}
          >
            {t('stop')}
          </Button>
        )}
      </div>
      {state.researchRun && (
        <p role="status">
          {t(`run.${state.researchRun.status}`)}
          {state.researchRun.errorCode && ` · ${t('generationFailed')}`}
        </p>
      )}
      {research?.draft.restricted || preview?.restricted ? (
        <p role="alert">{t('restricted')}</p>
      ) : document ? (
        <>
          <div className={css.toolbar}>
            <Button
              disabled={locked || preview !== null}
              onClick={() => {
                void actions.saveResearch()
              }}
            >
              {t('save')}
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                void actions.exportResearch(true)
              }}
            >
              {t('c.copy')}
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                void actions.exportResearch(false)
              }}
            >
              {t('c.download')}
            </Button>
          </div>
          {!canTransfer && <p>{t('c.reportSaveHelp')}</p>}
          <ReportView
            document={document}
            t={t}
            canTransfer={!locked && canTransfer}
            transfer={(direction) => {
              void actions.transferResearch(direction)
            }}
          />
        </>
      ) : (
        <p>{t('c.reportEmpty')}</p>
      )}
      {research && (
        <section>
          <h2>{t('c.reportHistory')}</h2>
          <ul className={css.versionList}>
            {state.reportVersions.map(version => (
              <li key={version.id}>
                <span>
                  V{version.versionNo} · {version.savedAt}
                </span>
                <Button
                  disabled={locked}
                  onClick={() => {
                    void actions.previewReport(version.id)
                    setRestore(false)
                  }}
                >
                  {t('c.preview')}
                </Button>
              </li>
            ))}
          </ul>
          {state.reportCursor && (
            <Button
              disabled={locked}
              onClick={() => {
                void actions.versions(true)
              }}
            >
              {t('c.more')}
            </Button>
          )}
          {preview && (
            <>
              <Button
                onClick={() => {
                  void actions.previewReport(null)
                  setRestore(false)
                }}
              >
                {t('c.backDraft')}
              </Button>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={restore}
                  onChange={(event) => {
                    setRestore(event.target.checked)
                  }}
                />
                {t('c.restoreConfirm')}
              </label>
              <Button
                disabled={locked || !restore || preview.restricted}
                onClick={() => {
                  void actions.restoreReport()
                  setRestore(false)
                }}
              >
                {t('restore')}
              </Button>
            </>
          )}
        </section>
      )}
      {research && <LegacyForm key={research.artifact.id} {...{ state, actions, t, maxBytes }} />}
    </div>
  )
}
function LegacyForm({ state, actions, t, maxBytes }: ContentProps) {
  const [text, setText] = useState(''),
    [origin, setOrigin] = useState(''),
    [consent, setConsent] = useState(false),
    [error, setError] = useState(false)
  const running = state.researchRun?.status === 'pending' || state.researchRun?.status === 'running'
  return (
    <details className={css.context}>
      <summary>{t('c.importLegacy')}</summary>
      <p>{t('c.legacy')}</p>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (consent) void actions.importLegacy(text, origin)
        }}
      >
        <TextFile
          {...{ t, maxBytes }}
          accept=".txt,.md"
          onText={(body, name) => {
            setText(body)
            setOrigin(name)
            setConsent(false)
            setError(false)
          }}
          onError={() => {
            setError(true)
          }}
        />
        {error && <p role="alert">{t('c.fileError')}</p>}
        <label>
          {t('c.legacyOrigin')}
          <Input
            required
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value)
              setConsent(false)
            }}
          />
        </label>
        <label>
          {t('sourceBody')}
          <textarea
            required
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setConsent(false)
            }}
          />
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked)
            }}
          />
          {t('c.legacyConsent')}
        </label>
        <Button type="submit" disabled={state.busy || state.uncertain || running || !consent}>
          {t('c.importLegacy')}
        </Button>
      </form>
    </details>
  )
}
const reportLabels: Readonly<Record<string, EducationKey>> = {
  overview: 'c.overviewReport',
  compact: 'c.compact',
  propagation: 'c.propagation',
  opening: 'c.opening',
  ending: 'c.ending',
  sections: 'c.sections',
  mechanisms: 'c.mechanisms',
  sidebar_analysis: 'c.sidebar_analysis',
  methods: 'c.methods',
  creative_directions: 'c.creative_directions',
  issues: 'c.issues',
  creation_note: 'c.creation_note',
  thesis: 'c.thesis',
  audience: 'c.audience',
  purpose: 'c.purpose',
  pain: 'c.pain',
  takeaway: 'c.takeaway',
  content_summary: 'c.content_summary',
  main_summary: 'c.main_summary',
  reasons: 'c.reasons',
  title: 'c.title',
  text: 'c.textValue',
  summary: 'c.summary',
  evidence: 'c.evidence',
  title_promise: 'c.title_promise',
  opening_move: 'c.opening_move',
  payoff: 'c.payoff',
  conclusion: 'c.conclusion',
  cta: 'c.cta',
  structure_tags: 'c.structure_tags',
  analysis_short: 'c.analysis_short',
  role: 'c.role',
  analysis: 'c.analysis',
  audience_reason: 'c.audience_reason',
  connection: 'c.connection',
  learn: 'c.learn',
  blocks: 'c.blocks',
  how: 'c.how',
  example: 'c.example',
  condition: 'c.condition',
  angle: 'c.angle',
  basis: 'c.basis',
  opening_idea: 'c.opening_idea',
  outline: 'c.outline',
  what_to_keep: 'c.what_to_keep',
  what_to_change: 'c.what_to_change',
  materials: 'c.materials',
}
function ReportView({
  document,
  t,
  canTransfer,
  transfer,
}: {
  document: ResearchDocument | LegacyResearchDocument
  t: T
  canTransfer: boolean
  transfer: (index: number) => void
}) {
  const [highlight, setHighlight] = useState<string | null>(null)
  if (document.kind === 'legacy-text')
    return (
      <section>
        <h2>{t('c.legacy')}</h2>
        <pre className={css.original}>{document.text}</pre>
      </section>
    )
  const parts: [string, unknown][] = Object.entries(document.report)
  const units = document.input.evidence.units
  const locate = (id: string) => {
    setHighlight(id)
    globalThis.document
      .getElementById(`research-evidence-${id}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
  return (
    <div className={css.reportGrid}>
      <article aria-label={t('c.reportDraft')}>
        {parts
          .filter(([key]) => !['schema_version', 'prompt_version'].includes(key))
          .map(([key, data]) => (
            <section key={key} className={css.reportSection}>
              <h2>{t(reportLabels[key] ?? 'c.details')}</h2>
              {key === 'creative_directions' ? (
                document.report.creative_directions.map((direction, index) => (
                  <section key={index}>
                    <ReportFields data={direction} t={t} locate={locate} />
                    <Button
                      disabled={!canTransfer}
                      onClick={() => {
                        transfer(index)
                      }}
                    >
                      {t('c.transferDirection')}
                    </Button>
                  </section>
                ))
              ) : (
                <ReportFields data={data} t={t} locate={locate} />
              )}
            </section>
          ))}
      </article>
      <aside className={css.evidence} aria-label={t('c.reportSource')}>
        <h2>{t('c.reportSource')}</h2>
        <p>{document.input.source.title}</p>
        <details className={css.context}><summary>{t('c.provenance')}</summary><dl>
          <dt>{t('c.originalTitle')}</dt><dd>{document.input.origin.originalTitle ?? t('c.missing')}</dd>
          <dt>{t('sourceUrl')}</dt><dd>{document.input.origin.sourceUrl ? <a href={document.input.origin.sourceUrl} target="_blank" rel="noopener noreferrer">{document.input.origin.sourceUrl}</a> : t('c.missing')}</dd>
          <dt>{t('c.fileHash')}</dt><dd className={css.original}>{document.input.origin.fileSha256 ?? t('c.missing')}</dd>
          <dt>{t('c.transcriptHash')}</dt><dd className={css.original}>{document.input.origin.transcriptObjectSha256 ?? t('c.missing')}</dd>
        </dl></details>
        {units.map((unit, index) => (
          <section
            id={`research-evidence-${unit.id}`}
            key={unit.id}
            className={highlight === unit.id ? css.highlight : css.reportSection}
          >
            <h3>
              {t(document.input.evidence.kind === 'text' ? 'c.paragraph' : 'c.segment')} {index + 1}
              {'start' in unit ? ` · ${unit.start}–${unit.end}s` : ''}
            </h3>
            <p className={css.original}>{unit.text}</p>
          </section>
        ))}
      </aside>
    </div>
  )
}
function ReportFields({ data, t, locate }: { data: unknown; t: T; locate: (id: string) => void }) {
  if (typeof data === 'string') return <p className={css.original}>{data}</p>
  if (Array.isArray(data))
    return (
      <ul>
        {data.map((item: unknown, index: number) => (
          <li key={index}>
            <ReportFields data={item} t={t} locate={locate} />
          </li>
        ))}
      </ul>
    )
  if (typeof data !== 'object' || data === null) return null
  if ('source_id' in data && typeof data.source_id === 'string' && 'quote' in data && typeof data.quote === 'string') {
    const sourceId = data.source_id
    return (
      <blockquote className={css.quote}>
        <p>{data.quote}</p>
        <Button
          onClick={() => {
            locate(sourceId)
          }}
        >
          {t('c.evidence')}
        </Button>
      </blockquote>
    )
  }
  const fields: [string, unknown][] = Object.entries(data)
  return (
    <dl>
      {fields
        .filter(([key]) => !['source_ids', 'short_title'].includes(key))
        .map(([key, item]) => (
          <div key={key}>
            <dt>{t(reportLabels[key] ?? 'c.details')}</dt>
            <dd>
              <ReportFields data={item} t={t} locate={locate} />
            </dd>
          </div>
        ))}
    </dl>
  )
}
const syncStatusLabels: Readonly<Record<string, EducationKey>> = { pending: 'c.syncPending', running: 'c.syncRunning', completed: 'c.syncCompleted', partial: 'c.syncPartial', failed: 'c.syncFailed', cancelled: 'c.syncCancelled', interrupted: 'c.syncInterrupted', unknown: 'c.syncUnknown' }
const syncPhaseLabels: Readonly<Record<string, EducationKey>> = { account: 'c.phaseAccount', works: 'c.phaseWorks', details: 'c.phaseDetails', done: 'c.phaseDone' }
function Analytics({ state, actions, t, maxBytes }: ContentProps) {
  const [platform, setPlatform] = useState<'douyin' | 'xiaohongshu'>('douyin'),
    [externalId, setExternalId] = useState(''),
    [title, setTitle] = useState(''),
    [keyword, setKeyword] = useState(''),
    [mode, setMode] = useState<'latest' | 'seven-days'>('latest'),
    [source, setSource] = useState(state.dataset?.source ?? 'redfox'),
    [composing, setComposing] = useState(false)
  const [original, setOriginal] = useState(''),
    [selected, setSelected] = useState<ContentObservation | null>(null),
    [reviewed, setReviewed] = useState(false)
  const locked = state.busy || state.uncertain,
    account = state.accounts.find(item => item.id === state.accountId),
    dataset = state.dataset
  useEffect(() => {
    if (dataset) setSource(dataset.source)
  }, [dataset?.source])
  useEffect(() => {
    if (dataset === null || !account?.permissions.view) {
      setSelected(null)
      setOriginal('')
    }
  }, [dataset, account?.permissions.view])
  return (
    <div className={css.stageGrid}>
      {!state.providerReady && (
        <p role="status" className={css.notice}>
          {t('c.noProvider')}
        </p>
      )}
      <label>
        {t('c.accounts')}
        <select
          value={state.accountId ?? ''}
          disabled={locked}
          onChange={(event) => {
            const account = state.accounts.find(item => item.id === event.target.value)
            if (account) void actions.selectAccount(account.id)
          }}
        >
          <option value="">{t('c.accounts')}</option>
          {state.accounts.map(item => (
            <option key={item.id} value={item.id}>
              {item.title} · {t(`c.${item.platform}`)}
            </option>
          ))}
        </select>
      </label>
      {!state.accounts.length && <p>{t('c.noAccounts')}</p>}
      <details className={css.context}>
        <summary>{t('c.createAccount')}</summary>
        <form
          className={css.contextForm}
          onSubmit={(event) => {
            event.preventDefault()
            void actions.createAccount({ platform, externalId, title })
          }}
        >
          <label>
            {t('c.platform')}
            <select
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value === 'xiaohongshu' ? 'xiaohongshu' : 'douyin')
              }}
            >
              <option value="douyin">{t('c.douyin')}</option>
              <option value="xiaohongshu">{t('c.xiaohongshu')}</option>
            </select>
          </label>
          <label>
            {t('c.externalId')}
            <Input
              required
              value={externalId}
              onChange={(event) => {
                setExternalId(event.target.value)
              }}
            />
          </label>
          <label>
            {t('c.accountTitle')}
            <Input
              required
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
          </label>
          <Button type="submit" disabled={locked}>
            {t('c.createAccount')}
          </Button>
        </form>
      </details>
      {account && (
        <>
          {account.permissions.view && (
            <form
              className={css.contextForm}
              onSubmit={(event) => {
                event.preventDefault()
                if (!composing) void actions.queryAnalytics({ mode, source, keyword })
              }}
            >
              <label>
                {t('c.source')}
                <select
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value)
                  }}
                >
                  {[...new Set(['redfox', ...(dataset?.sources ?? [])])].map(item => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('c.window')}
                <select
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value === 'seven-days' ? 'seven-days' : 'latest')
                  }}
                >
                  <option value="latest">{t('c.latest')}</option>
                  <option value="seven-days">{t('c.seven')}</option>
                </select>
              </label>
              <label>
                {t('c.keyword')}
                <Input
                  value={keyword}
                  onCompositionStart={() => {
                    setComposing(true)
                  }}
                  onCompositionEnd={() => {
                    setComposing(false)
                  }}
                  onChange={(event) => {
                    setKeyword(event.target.value)
                  }}
                />
              </label>
              <Button type="submit" disabled={locked || composing}>
                {t('c.refresh')}
              </Button>
            </form>
          )}
          <p>{t('c.syncHelp')}</p>
          <div className={css.toolbar}>
            <Button
              disabled={locked || !account.enabled || !account.permissions.sync || !state.providerReady}
              onClick={() => {
                void actions.sync(mode)
              }}
            >
              {t('c.sync')} · {t(mode === 'latest' ? 'c.latest' : 'c.seven')}
            </Button>
            <Button
              disabled={locked || !account.permissions.export || !account.permissions.view}
              onClick={() => {
                void actions.exportAnalytics()
              }}
            >
              {t('c.exportData')}
            </Button>
          </div>
          {dataset && (
            <>
              <p>{t('c.cumulative')}</p>
              <p>
                {t('c.coverage')}: {t(`c.${dataset.coverage}`)}
                {dataset.truncated ? ` · ${t('c.partial')}` : ''}
              </p>
              {dataset.analysis.window && (
                <p>
                  {dataset.analysis.window.from} ≤ {t('c.publishedAt')} &lt; {dataset.analysis.window.to}
                </p>
              )}
              <h2>{t('c.overview')}</h2>
              {dataset.overview ? (
                <>
                  <Metrics fields={dataset.overview.fields} t={t} names={['followers', 'totalLikes', 'workCount']} />
                  <p>
                    {t('c.fetchedAt')}: {dataset.overview.fetchedAt} · {t('c.sourceDataAt')}:{' '}
                    {dataset.overview.sourceDataAt ?? t('c.unknownTime')}
                  </p>
                </>
              ) : (
                <p>{t('c.noOverview')}</p>
              )}
              <p>
                {t('c.median')}: {dataset.analysis.medianLikes ?? t('c.missing')} · {t('c.sample')}:{' '}
                {dataset.analysis.validSampleCount} / {dataset.analysis.baselineCount}
              </p>
              <ContentRows
                title={t('c.videos')}
                items={dataset.analysis.items}
                above={dataset.analysis.aboveMedian.map(item => item.snapshotId)}
                t={t}
                select={(item) => {
                  setSelected(item)
                  setOriginal('')
                }}
              />
              <ContentRows
                title={t('c.images')}
                items={dataset.analysis.images}
                above={[]}
                t={t}
                select={(item) => {
                  setSelected(item)
                  setOriginal('')
                }}
              />
              <ContentRows
                title={t('c.undated')}
                items={dataset.analysis.undated}
                above={[]}
                t={t}
                select={(item) => {
                  setSelected(item)
                  setOriginal('')
                }}
              />
            </>
          )}
          {selected && (
            <section className={css.manuscript}>
              <h2>
                {t('c.transfer')}: {selected.title}
              </h2>
              <p>{t('c.transferHelp')}</p>
              <label>
                {t('c.originalText')}
                <textarea
                  value={original}
                  onChange={(event) => {
                    setOriginal(event.target.value)
                  }}
                />
              </label>
              <div className={css.toolbar}>
                <Button
                  disabled={locked || !account.permissions.use_for_ai || state.projectId === null}
                  onClick={() => {
                    void actions.transferAnalytics(selected.snapshotId, 'writing', original)
                  }}
                >
                  {t('c.transferWriting')}
                </Button>
                <Button
                  disabled={locked || !account.permissions.use_for_ai || !original.trim() || state.projectId === null}
                  onClick={() => {
                    void actions.transferAnalytics(selected.snapshotId, 'research', original)
                  }}
                >
                  {t('c.transferResearch')}
                </Button>
              </div>
            </section>
          )}
          {account.permissions.sync && <MetricImport {...{ state, actions, t, maxBytes }} />}
          {account.permissions.manage && (
            <>
              <GrantForm {...{ state, actions, t }} />
              <Button
                disabled={locked}
                onClick={() => {
                  void actions.enableAccount(!account.enabled)
                }}
              >
                {t(account.enabled ? 'c.disable' : 'c.enable')}
              </Button>
              <DailyForm {...{ state, actions, t }} />
            </>
          )}
          <section>
            <h2>{t('c.runHistory')}</h2>
            <ul>
              {state.runs.map(run => (
                <li key={run.id} className={css.reportSection}>
                  <p>
                    {run.createdAt} · {t(run.mode === 'latest' ? 'c.latest' : 'c.seven')} · {t(syncStatusLabels[run.status] ?? 'c.unknown')} ·{' '}
                    {t('c.phase')}: {t(syncPhaseLabels[run.phase] ?? 'c.unknown')} · {t('c.pages')}: {run.completedPages}
                  </p>
                  {['pending', 'running', 'interrupted'].includes(run.status) && (
                    <Button
                      disabled={locked}
                      onClick={() => {
                        void actions.stopSync(run)
                      }}
                    >
                      {t('stop')}
                    </Button>
                  )}
                  {run.status === 'unknown' && (
                    <>
                      <p role="alert">{t('c.unknownRun')}</p>
                      {account.permissions.manage && (
                        <>
                          <label className={css.check}>
                            <input
                              type="checkbox"
                              checked={reviewed}
                              onChange={(event) => {
                                setReviewed(event.target.checked)
                              }}
                            />
                            {t('c.reviewUnknown')}
                          </label>
                          <Button
                            disabled={locked || !reviewed}
                            onClick={() => {
                              void actions.stopSync(run, true)
                              setReviewed(false)
                            }}
                          >
                            {t('c.reviewUnknown')}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
function Metrics({ fields, t, names }: { fields: MetricFields; t: T; names: readonly (keyof MetricFields)[] }) {
  return (
    <dl className={css.metrics}>
      {names.map(name => (
        <div key={name}>
          <dt>{t(`c.${name}`)}</dt>
          <dd>
            {fields[name].state === 'known'
              ? fields[name].value
              : fields[name].state === 'estimated'
                ? `${fields[name].value ?? t('c.missing')} (${t('c.estimated')})`
                : t(fields[name].state === 'not-authorized' ? 'c.notAuthorized' : 'c.missing')}
          </dd>
        </div>
      ))}
    </dl>
  )
}
function ContentRows({
  title,
  items,
  above,
  t,
  select,
}: {
  title: string
  items: readonly ContentObservation[]
  above: readonly string[]
  t: T
  select: (item: ContentObservation) => void
}) {
  return (
    <section>
      <h2>{title}</h2>
      {!items.length && <p>{t('c.emptyData')}</p>}
      <ul>
        {items.map(item => (
          <li key={item.snapshotId} className={css.reportSection}>
            <h3>{item.title || item.externalId}</h3>
            <p>
              {t('c.publishedAt')}: {item.publishedAt ?? t('c.unknownTime')}
            </p>
            <Metrics fields={item.fields} t={t} names={['likes', 'collects', 'comments', 'shares', 'views']} />
            <p>
              {t('c.source')}: {item.source} · {t('c.fetchedAt')}: {item.fetchedAt} · {t('c.sourceDataAt')}:{' '}
              {item.sourceDataAt ?? t('c.unknownTime')}
            </p>
            {above.includes(item.snapshotId) && <p>{t('c.aboveMedian')}</p>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {t('sourceUrl')}
              </a>
            )}
            <Button
              onClick={() => {
                select(item)
              }}
            >
              {t('c.transfer')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
function MetricImport({ state, actions, t, maxBytes }: ContentProps) {
  const [content, setContent] = useState(''),
    [sourceLabel, setSourceLabel] = useState(''),
    [observedAt, setObservedAt] = useState(''),
    [partial, setPartial] = useState(false),
    [fileError, setFileError] = useState(false)
  const preview = state.preview,
    locked = state.busy || state.uncertain
  return (
    <details className={css.context}>
      <summary>{t('c.metricImport')}</summary>
      <p>{t('c.importSchema')}</p>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          setPartial(false)
          void actions.previewImport({ content, sourceLabel, observedAt })
        }}
      >
        <TextFile
          {...{ t, maxBytes }}
          accept=".json"
          onText={(text) => {
            setContent(text)
            setFileError(false)
          }}
          onError={() => {
            setFileError(true)
          }}
        />
        {fileError && <p role="alert">{t('c.fileError')}</p>}
        <label>
          {t('c.sourceLabel')}
          <Input
            required
            value={sourceLabel}
            onChange={(event) => {
              setSourceLabel(event.target.value)
            }}
          />
        </label>
        <label>
          {t('c.observedAt')}
          <Input
            required
            placeholder="2026-10-15T09:00:00+08:00"
            value={observedAt}
            onChange={(event) => {
              setObservedAt(event.target.value)
            }}
          />
        </label>
        <label>
          {t('sourceBody')}
          <textarea
            required
            value={content}
            onChange={(event) => {
              setContent(event.target.value)
            }}
          />
        </label>
        <Button type="submit" disabled={locked}>
          {t('c.previewImport')}
        </Button>
      </form>
      {preview && (
        <section>
          <p>
            {t('c.source')}: {preview.source} · {t('c.observedAt')}: {preview.observedAt}
          </p>
          <p className={css.original}>
            {t('c.fileHash')}: {preview.fileHash}
          </p>
          <p>
            {t('c.valid')}: {preview.validRows} · {t('c.rejected')}: {preview.rejectedRows} · {t('c.skipped')}:{' '}
            {preview.skippedRows}
          </p>
          <ul>
            {preview.sample.map((item, index) => (
              <li key={index}>
                {item.title || item.externalId} · {item.kind} · {t('c.likes')}:{' '}
                {item.fields.likes.value ?? t('c.missing')}
              </li>
            ))}
          </ul>
          <ul>
            {preview.errors.map((error, index) => (
              <li key={index}>
                {error.row}: {error.code}
              </li>
            ))}
          </ul>
          {preview.rejectedRows > 0 && (
            <label className={css.check}>
              <input
                type="checkbox"
                checked={partial}
                onChange={(event) => {
                  setPartial(event.target.checked)
                }}
              />
              {t('c.partialConfirm')}
            </label>
          )}
          <Button
            disabled={locked || (preview.rejectedRows > 0 && !partial)}
            onClick={() => {
              void actions.confirmImport(partial)
            }}
          >
            {t('c.confirmImport')}
          </Button>
        </section>
      )}
      {state.importResult?.operation === 'imports.commit' && (
        <p role="status">
          {t('c.accepted')}: {state.importResult.accepted} · {t('c.rejected')}: {state.importResult.rejected} ·{' '}
          {t('c.skipped')}: {state.importResult.skipped}
        </p>
      )}
    </details>
  )
}
const permissionKeys: readonly (keyof AccountPermissions)[] = ['view', 'sync', 'manage', 'export', 'use_for_ai']
const permissionLabels: Readonly<Record<keyof AccountPermissions, EducationKey>> = {
  view: 'c.view',
  sync: 'c.syncPermission',
  manage: 'c.manage',
  export: 'c.exportPermission',
  use_for_ai: 'c.ai',
}
function GrantForm({ state, actions, t }: Omit<ContentProps, 'maxBytes'>) {
  const [username, setUsername] = useState(''),
    [permissions, setPermissions] = useState<AccountPermissions>({
      view: false,
      sync: false,
      manage: false,
      export: false,
      use_for_ai: false,
    })
  const grant = state.grants.find(item => item.username === username.normalize('NFKC').trim().toLowerCase())
  return (
    <details className={css.context}>
      <summary>{t('c.grants')}</summary>
      <p>{t('c.grantHelp')}</p>
      <ul>
        {state.grants.map(item => (
          <li key={item.userId} className={css.sourceRow}>
            <span>
              {item.username} ·{' '}
              {permissionKeys
                .filter(key => item.permissions[key])
                .map(key => t(permissionLabels[key]))
                .join(' / ')}
            </span>
            <Button
              onClick={() => {
                setUsername(item.username)
                setPermissions(item.permissions)
              }}
            >
              {t('editSource')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          void actions.grant({ username, permissions, expectedRevision: grant?.revision ?? 0 })
        }}
      >
        <label>
          {t('c.username')}
          <Input
            required
            value={username}
            onChange={(event) => {
              setUsername(event.target.value)
              setPermissions({ view: false, sync: false, manage: false, export: false, use_for_ai: false })
            }}
          />
        </label>
        {permissionKeys.map(key => (
          <label key={key} className={css.check}>
            <input
              type="checkbox"
              checked={permissions[key]}
              onChange={(event) => {
                setPermissions(previous => ({ ...previous, [key]: event.target.checked }))
              }}
            />
            {t(permissionLabels[key])}
          </label>
        ))}
        <Button type="submit" disabled={state.busy || state.uncertain}>
          {t('c.saveGrant')}
        </Button>
      </form>
    </details>
  )
}
function DailyForm({ state, actions, t }: Omit<ContentProps, 'maxBytes'>) {
  const [enabled, setEnabled] = useState(state.schedule?.enabled ?? false),
    [hour, setHour] = useState(state.schedule?.hour ?? 6),
    [minute, setMinute] = useState(state.schedule?.minute ?? 0),
    [timeZone, setTimeZone] = useState(state.schedule?.timeZone ?? 'Asia/Shanghai')
  useEffect(() => {
    setEnabled(state.schedule?.enabled ?? false)
    setHour(state.schedule?.hour ?? 6)
    setMinute(state.schedule?.minute ?? 0)
    setTimeZone(state.schedule?.timeZone ?? 'Asia/Shanghai')
  }, [state.schedule?.revision])
  return (
    <details className={css.context}>
      <summary>{t('c.daily')}</summary>
      <p>{t('c.dailyHelp')}</p>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          void actions.schedule({ enabled, hour, minute, timeZone })
        }}
      >
        <label>
          {t('c.hour')}
          <Input
            type="number"
            required
            min={0}
            max={23}
            value={hour}
            onChange={(event) => {
              setHour(Number(event.target.value))
            }}
          />
        </label>
        <label>
          {t('c.minute')}
          <Input
            type="number"
            required
            min={0}
            max={59}
            value={minute}
            onChange={(event) => {
              setMinute(Number(event.target.value))
            }}
          />
        </label>
        <label>
          {t('c.timeZone')}
          <Input
            required
            value={timeZone}
            onChange={(event) => {
              setTimeZone(event.target.value)
            }}
          />
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked)
            }}
          />
          {t('c.dailyConsent')}
        </label>
        <Button type="submit" disabled={state.busy || state.uncertain}>
          {t('c.saveSchedule')}
        </Button>
      </form>
      {state.schedule && (
        <p>
          {t('c.nextAt')}: {state.schedule.nextAt}
        </p>
      )}
    </details>
  )
}
function TextFile({
  t,
  maxBytes,
  accept,
  onText,
  onError,
}: {
  t: T
  maxBytes: number
  accept: string
  onText: (text: string, name: string) => void
  onError: () => void
}) {
  const [reading, setReading] = useState(false)
  return (
    <label>
      {t('c.file')}
      <input
        type="file"
        accept={accept}
        disabled={reading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (
            file.size > maxBytes ||
            !accept.split(',').some(extension => file.name.toLowerCase().endsWith(extension))
          ) {
            onError()
            return
          }
          setReading(true)
          void file
            .arrayBuffer()
            .then((bytes) => {
              onText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file.name)
            })
            .catch(onError)
            .finally(() => {
              setReading(false)
            })
        }}
      />
    </label>
  )
}
