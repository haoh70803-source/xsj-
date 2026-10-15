/** Native main-slot surface. Data and subscriptions belong to EducationWorkspace. */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  Input,
  IconEditOutlineRegular,
  IconLoadingOutlineRegular,
  Modal,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EducationWorkspace, WorkspaceSnapshot } from './model.ts'
import type { CreationScenario, TextSelection } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { ContextControls, CreationControls } from './creation-panel.tsx'
import css from './panel.module.css'

/** Plain command callbacks, derived from the model rather than passing the service. */
export interface WorkspaceFace {
  readonly saveProfile: EducationWorkspace['saveProfile']
  readonly saveSource: EducationWorkspace['saveSource']
  readonly authorizeSource: EducationWorkspace['authorizeSource']
  readonly refreshContext: EducationWorkspace['refreshContext']
  readonly generate: EducationWorkspace['generate']
  readonly cancelGeneration: EducationWorkspace['cancelGeneration']
  readonly applyCandidate: EducationWorkspace['applyCandidate']
  readonly setComposing: EducationWorkspace['setComposing']
  readonly maxTextFileBytes: number
  readonly resetContext: EducationWorkspace['resetContext']
  readonly hooks: { readonly education: HostObservable<WorkspaceSnapshot> }
  readonly authenticate: EducationWorkspace['authenticate']
  readonly signOut: EducationWorkspace['signOut']
  readonly list: EducationWorkspace['list']
  readonly open: EducationWorkspace['open']
  readonly create: EducationWorkspace['create']
  readonly edit: EducationWorkspace['edit']
  readonly sync: EducationWorkspace['sync']
  readonly save: EducationWorkspace['save']
  readonly versions: EducationWorkspace['versions']
  readonly preview: EducationWorkspace['preview']
  readonly restore: EducationWorkspace['restore']
  readonly resolve: EducationWorkspace['resolve']
  readonly exportText: (target: 'draft' | 'version') => Promise<void>
  readonly dismissNotice: EducationWorkspace['dismissNotice']
}
type PanelProps = PropsRuntime<'main'> & PropsLocale<'education'> & InjectFace<WorkspaceFace>
type ContentProps = Omit<InjectFace<WorkspaceFace>, 'useEducation'> &
  PropsLocale<'education'> & { state: WorkspaceSnapshot }

/** Framework supplies the only external-data hook. The key clears form and confirmation state on identity changes. */
export function EducationPanel({ useEducation, ...actions }: PanelProps) {
  const state = useEducation(value => value)
  return <PanelContent key={state.generation} {...actions} state={state} />
}
function PanelContent({ state, t, ...actions }: ContentProps) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [title, setTitle] = useState('')
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const [scenario, setScenario] = useState<CreationScenario>('spoken-script')
  const [selection, setSelection] = useState<{ value: TextSelection; artifactId: string; body: string } | null>(null)
  const [resetting, setResetting] = useState(false)
  const running = state.run?.status === 'pending' || state.run?.status === 'running'
  const locked = state.busy || state.uncertain || state.syncing
  const editorLocked = state.busy || state.uncertain || running || state.project?.draft.restricted
  const selected =
    selection?.artifactId === state.project?.artifact.id && selection?.body === state.text.replaceAll('\r\n', '\n')
      ? selection.value
      : null
  const creationProps = { ...actions, state, t, selection: selected }
  const outdated =
    state.creation?.basis.source === 'creation-context' &&
    state.profile !== null &&
    state.creation.basis.profileVersionIds[0] !== state.profile.id
  const guard = (action: () => void): void => {
    if (state.dirty) setLeaving(() => action)
    else action()
  }
  return (
    <section className={css.panel} aria-label={t('panel')} aria-busy={state.busy}>
      {state.busy && (
        <div className={css.loading} role="status" aria-label={t('loading')}>
          <IconLoadingOutlineRegular className={css.spinner} size={24} />
        </div>
      )}
      <header className={css.header}>
        <h1>{t('panel')}</h1>
        {state.user && (
          <div className={css.toolbar}>
            <span>
              {t('employee')}: {state.user.username}
            </span>
            <Button
              disabled={state.busy}
              onClick={() => {
                guard(() => {
                  void actions.signOut()
                })
              }}
            >
              {t('signOut')}
            </Button>
          </div>
        )}
      </header>
      {state.user && <ContextControls {...creationProps} />}
      {state.problem && (
        <div role="alert" className={css.notice}>
          <p>{t(`problem.${state.problem}`)}</p>
          {!state.user && (
            <Button
              disabled={state.busy}
              onClick={() => {
                void actions.authenticate()
              }}
            >
              {t('recheck')}
            </Button>
          )}
          {state.uncertain && (
            <>
              <p>{t('unknownHelp')}</p>
              <div className={css.toolbar}>
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
            </>
          )}
        </div>
      )}
      <Modal
        open={leaving !== null}
        title={t('unsaved')}
        closeLabel={t('cancel')}
        onClose={() => {
          setLeaving(null)
        }}
        footer={
          <div className={css.toolbar}>
            <Button
              variant="outline"
              onClick={() => {
                setLeaving(null)
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                const action = leaving
                setLeaving(null)
                action?.()
              }}
            >
              {t('discard')}
            </Button>
          </div>
        }
      />
      <Modal
        open={resetting}
        title={t('resetHelp')}
        closeLabel={t('cancel')}
        onClose={() => {
          setResetting(false)
        }}
        footer={
          <div className={css.toolbar}>
            <Button
              variant="outline"
              onClick={() => {
                setResetting(false)
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                setResetting(false)
                void actions.resetContext()
              }}
            >
              {t('confirmReset')}
            </Button>
          </div>
        }
      />
      {!state.user ? (
        <form
          className={css.login}
          onSubmit={(event) => {
            event.preventDefault()
            const credentials = { username, password }
            setPassword('')
            void actions.authenticate(credentials)
          }}
        >
          <label>
            {t('username')}
            <Input
              required
              autoComplete="username"
              value={username}
              disabled={state.busy}
              onChange={(event) => {
                setUsername(event.target.value)
              }}
            />
          </label>
          <label>
            {t('password')}
            <Input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={state.busy}
              onChange={(event) => {
                setPassword(event.target.value)
              }}
            />
          </label>
          <Button type="submit" variant="primary" disabled={state.busy}>
            {t('signIn')}
          </Button>
        </form>
      ) : (
        <div className={css.body}>
          <nav aria-label={t('projects')} className={css.projects}>
            <h2>{t('projects')}</h2>
            <form
              className={css.create}
              onSubmit={(event) => {
                event.preventDefault()
                guard(() => {
                  void actions.create(title, true, scenario)
                })
              }}
            >
              <label>
                {t('title')}
                <Input
                  required
                  value={title}
                  disabled={locked}
                  onChange={(event) => {
                    setTitle(event.target.value)
                  }}
                />
              </label>
              <label>
                {t('scenario')}
                <select
                  value={scenario}
                  disabled={locked}
                  onChange={(event) => {
                    setScenario(event.target.value === 'moments' ? 'moments' : 'spoken-script')
                  }}
                >
                  <option value="spoken-script">{t('spokenScript')}</option>
                  <option value="moments">{t('moments')}</option>
                </select>
              </label>
              <Button type="submit" variant="outline" disabled={locked}>
                {t('create')}
              </Button>
            </form>
            <Button
              disabled={locked}
              onClick={() => {
                void actions.list()
              }}
            >
              {t('refresh')}
            </Button>
            {state.projects.length === 0 && !state.busy && <p>{t('empty')}</p>}
            <ul>
              {state.projects.map(project => (
                <li key={project.id}>
                  <Button
                    disabled={locked}
                    aria-current={state.project?.project.id === project.id ? 'page' : undefined}
                    onClick={() => {
                      guard(() => {
                        void actions.open(project.id, true)
                      })
                    }}
                  >
                    {project.title}
                  </Button>
                </li>
              ))}
            </ul>
            {state.projectsCursor && (
              <Button
                disabled={locked}
                onClick={() => {
                  void actions.list(true)
                }}
              >
                {t('more')}
              </Button>
            )}
          </nav>
          {state.project ? (
            <div className={css.editor}>
              <h2>{state.project.project.title}</h2>
              <CreationControls key={state.project.artifact.id} {...creationProps} />
              {state.project.draft.restricted && <p role="alert">{t('restricted')}</p>}
              {outdated && <p role="status">{t('outdated')}</p>}
              {(state.project.draft.restricted || outdated) && (
                <Button
                  disabled={locked || running}
                  onClick={() => {
                    setResetting(true)
                  }}
                >
                  {t('resetContext')}
                </Button>
              )}
              <Manuscript
                key={state.project.artifact.id}
                hasBody={state.text !== '' || state.versions.length > 0 || !!state.project.draft.restricted}
                label={t('manuscript')}
              >
                {state.syncing && <p role="status">{t('syncing')}</p>}
                <div role="status" aria-label={t('draftStatus')}>
                  {t(state.dirty ? 'dirty' : 'clean')} · {t('revision')}: {state.project.draft.revision} · {t('latest')}
                  :{' '}
                  {state.project.artifact.latestVersionId
                    ? (state.versions.find(version => version.id === state.project?.artifact.latestVersionId)
                      ?.versionNo ?? '—')
                    : t('none')}
                </div>
                <label className={css.draft}>
                  {t('draft')}
                  <textarea
                    value={state.text}
                    disabled={editorLocked}
                    onChange={(event) => {
                      setSelection(null)
                      actions.edit(event.target.value)
                    }}
                    onCompositionStart={() => {
                      actions.setComposing(true)
                    }}
                    onCompositionEnd={() => {
                      actions.setComposing(false)
                    }}
                    onSelect={(event) => {
                      const element = event.currentTarget,
                        body = element.value,
                        start = element.selectionStart,
                        end = element.selectionEnd,
                        artifactId = state.project?.artifact.id
                      if (start === end || !artifactId) {
                        setSelection(null)
                        return
                      }
                      void crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)).then((hash) => {
                        if (element.value !== body || element.selectionStart !== start || element.selectionEnd !== end)
                          return
                        const bodyHash = Array.from(new Uint8Array(hash), byte =>
                          byte.toString(16).padStart(2, '0'),
                        ).join('')
                        setSelection({
                          artifactId,
                          body,
                          value: { start, end, original: body.slice(start, end), bodyHash },
                        })
                      })
                    }}
                    spellCheck
                  />
                </label>
                <div className={css.toolbar}>
                  <Button
                    variant="outline"
                    disabled={locked || running || state.project.draft.restricted || !state.dirty}
                    onClick={() => {
                      void actions.sync()
                    }}
                  >
                    {t('sync')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={locked || running || state.project.draft.restricted}
                    onClick={() => {
                      void actions.save()
                    }}
                  >
                    {t('save')}
                  </Button>
                  <Button
                    disabled={locked}
                    onClick={() => {
                      guard(() => {
                        if (state.project) void actions.open(state.project.project.id, true)
                      })
                    }}
                  >
                    {t('reload')}
                  </Button>
                  <Button
                    disabled={locked || state.dirty || state.project.draft.restricted}
                    onClick={() => {
                      void actions.exportText('draft')
                    }}
                  >
                    {t('exportDraft')}
                  </Button>
                </div>
                <p className={css.hint}>{t('exportHelp')}</p>
                <section aria-label={t('history')}>
                  <h2>{t('history')}</h2>
                  <Button
                    disabled={locked}
                    onClick={() => {
                      void actions.versions()
                    }}
                  >
                    {t('retry')}
                  </Button>
                  {!state.versions.length && <p>{t('noVersions')}</p>}
                  <ul className={css.versionList}>
                    {state.versions.map(version => (
                      <li key={version.id}>
                        <Button
                          disabled={locked}
                          aria-pressed={state.preview?.id === version.id}
                          onClick={() => {
                            void actions.preview(version)
                          }}
                        >
                          {t('preview')} {version.versionNo}
                        </Button>
                        <time dateTime={version.savedAt}>{version.savedAt}</time>
                      </li>
                    ))}
                  </ul>
                  {state.versionsCursor && (
                    <Button
                      disabled={locked}
                      onClick={() => {
                        void actions.versions(true)
                      }}
                    >
                      {t('more')}
                    </Button>
                  )}
                  {state.preview && (
                    <div className={css.preview}>
                      <h3>
                        {t('version')} {state.preview.versionNo}
                      </h3>
                      <label>
                        {t('previewTitle')}
                        <textarea readOnly value={state.preview.body} />
                      </label>
                      {state.preview.restricted && <p role="alert">{t('restricted')}</p>}
                      <div className={css.toolbar}>
                        <Button
                          disabled={locked || running || state.preview.restricted}
                          onClick={() => {
                            guard(() => {
                              void actions.restore(true)
                            })
                          }}
                        >
                          {t('restore')}
                        </Button>
                        <Button
                          disabled={locked || state.preview.restricted}
                          onClick={() => {
                            void actions.exportText('version')
                          }}
                        >
                          {t('exportVersion')}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              </Manuscript>
            </div>
          ) : (
            <p className={css.empty}>{t('choose')}</p>
          )}
        </div>
      )}
    </section>
  )
}
function Manuscript({ hasBody, label, children }: { hasBody: boolean; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(hasBody)
  useEffect(() => {
    if (hasBody) setOpen(true)
  }, [hasBody])
  return (
    <details
      className={css.manuscript}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
      }}
    >
      <summary>{label}</summary>
      {children}
    </details>
  )
}
/** The sidebar owns navigation and its accessible label. */
export function EducationPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconEditOutlineRegular size={size} />
}
/** App-level feedback survives main-panel navigation. */
export function EducationNotice({
  useEducation,
  dismissNotice,
  t,
}: InjectFace<Pick<WorkspaceFace, 'hooks' | 'dismissNotice'>> & PropsLocale<'education'>) {
  const state = useEducation(value => value)
  return state.notice ? (
    <Toast key={state.noticeId} tone="success" text={t(`notice.${state.notice}`)} onDone={dismissNotice} />
  ) : null
}
