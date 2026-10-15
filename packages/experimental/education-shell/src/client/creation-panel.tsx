/** Plain-prop profile, source and creation controls; the workspace object owns all remote state. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ProfileVersion,
  SourceDTO,
  SourceVersionId,
  TextSelection,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { WorkspaceFace } from './panel.tsx'
import type { WorkspaceSnapshot } from './model.ts'
import css from './panel.module.css'

/** Explicit callbacks and localized copy, without a Cordis service or manual subscription. */
export type CreationControlsProps = Pick<
  WorkspaceFace,
  | 'saveProfile'
  | 'saveSource'
  | 'authorizeSource'
  | 'generate'
  | 'cancelGeneration'
  | 'refreshContext'
  | 'applyCandidate'
  | 'maxTextFileBytes'
> &
  PropsLocale<'education'> & {
    state: WorkspaceSnapshot
    selection: TextSelection | null
  }
/** Owner context stays available across projects; form keys clear obsolete or revoked private text. */
export function ContextControls({ state, t, ...actions }: CreationControlsProps) {
  return (
    <details className={css.context}>
      <summary>{t('context')}</summary>
      <ProfileEditor
        key={state.profile?.id ?? 'new'}
        profile={state.profile}
        locked={state.busy || state.uncertain}
        t={t}
        save={actions.saveProfile}
      />
      <SourceEditor
        key={state.sources.map(source => `${source.versionId}:${source.authorizationRevision}`).join(',')}
        sources={state.sources}
        locked={state.busy || state.uncertain}
        t={t}
        save={actions.saveSource}
        authorize={actions.authorizeSource}
        maxTextFileBytes={actions.maxTextFileBytes}
      />
      <Button
        disabled={state.busy}
        onClick={() => {
          void actions.refreshContext()
        }}
      >
        {t('refreshContext')}
      </Button>
    </details>
  )
}
function ProfileEditor({
  profile,
  locked,
  t,
  save,
}: PropsLocale<'education'> & { profile: ProfileVersion | null; locked: boolean; save: WorkspaceFace['saveProfile'] }) {
  const [facts, setFacts] = useState(profile?.facts ?? ''),
    [preferences, setPreferences] = useState(profile?.preferences ?? ''),
    [prohibitedPromises, setProhibited] = useState(profile?.prohibitedPromises ?? '')
  return (
    <form
      className={css.contextForm}
      onSubmit={(event) => {
        event.preventDefault()
        void save({ facts, preferences, prohibitedPromises })
      }}
    >
      <h2>{t('profile')}</h2>
      <p className={css.hint}>{t('profileHelp')}</p>
      <label>
        {t('facts')}
        <textarea
          aria-label={t('facts')}
          required
          value={facts}
          disabled={locked}
          onChange={(event) => {
            setFacts(event.target.value)
          }}
        />
      </label>
      <label>
        {t('preferences')}
        <textarea
          aria-label={t('preferences')}
          value={preferences}
          disabled={locked}
          onChange={(event) => {
            setPreferences(event.target.value)
          }}
        />
      </label>
      <label>
        {t('prohibited')}
        <textarea
          aria-label={t('prohibited')}
          value={prohibitedPromises}
          disabled={locked}
          onChange={(event) => {
            setProhibited(event.target.value)
          }}
        />
      </label>
      <Button type="submit" disabled={locked}>
        {t('saveProfile')}
      </Button>
      {profile && (
        <p role="status">
          {t('profileRevision')} {profile.revision}
        </p>
      )}
    </form>
  )
}
function SourceEditor({
  sources,
  locked,
  t,
  save,
  authorize,
  maxTextFileBytes,
}: PropsLocale<'education'> & {
  sources: readonly SourceDTO[]
  locked: boolean
  save: WorkspaceFace['saveSource']
  authorize: WorkspaceFace['authorizeSource']
  maxTextFileBytes: number
}) {
  const [selected, setSelected] = useState<SourceDTO | null>(null),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [sourceUrl, setUrl] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [fileError, setFileError] = useState(false)
  return (
    <section className={css.contextForm} aria-label={t('sources')}>
      <h2>{t('sources')}</h2>
      <p className={css.hint}>{t('sourcesHelp')}</p>
      <ul>
        {sources.map(source => (
          <li key={source.id} className={css.sourceRow}>
            <span>
              {source.title} · {source.revision} · {t(source.authorized ? 'authorized' : 'revoked')}
            </span>
            <Button
              disabled={locked || !source.authorized}
              onClick={() => {
                setSelected(source)
                setTitle(source.title)
                setBody(source.body)
                setUrl(source.sourceUrl)
                setConfirmed(false)
              }}
            >
              {t('editSource')}
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                void authorize(source, !source.authorized)
              }}
            >
              {t(source.authorized ? 'revoke' : 'reauthorize')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className={css.contextForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (confirmed) void save({ ...(selected ? { source: selected } : {}), title, body, sourceUrl })
        }}
      >
        <label>
          {t('sourceTitle')}
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
          {t('sourceBody')}
          <textarea
            aria-label={t('sourceBody')}
            required
            value={body}
            disabled={locked}
            onChange={(event) => {
              setBody(event.target.value)
            }}
          />
        </label>
        <label>
          {t('sourceUrl')}
          <Input
            type="url"
            value={sourceUrl}
            disabled={locked}
            onChange={(event) => {
              setUrl(event.target.value)
            }}
          />
        </label>
        <label>
          {t('importText')}
          <input
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            disabled={locked}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              if (!/\.(txt|md)$/i.test(file.name) || file.size > maxTextFileBytes) {
                setFileError(true)
                return
              }
              setFileError(false)
              void file
                .text()
                .then((text) => {
                  setBody(text)
                  if (!title) setTitle(file.name)
                })
                .catch(() => {
                  setFileError(true)
                })
            }}
          />
        </label>
        {fileError && <p role="alert">{t('fileError')}</p>}
        <label className={css.check}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={locked}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
          />
          {t('confirmSource')}
        </label>
        <div className={css.toolbar}>
          <Button type="submit" disabled={locked || !confirmed}>
            {t('saveSource')}
          </Button>
          {selected && (
            <Button
              onClick={() => {
                setSelected(null)
                setTitle('')
                setBody('')
                setUrl('')
                setConfirmed(false)
              }}
            >
              {t('newSource')}
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
/** Conversation and manuscript use separate controls and never treat partial output as a saved draft. */
export function CreationControls({ state, selection, t, ...actions }: CreationControlsProps) {
  const [instruction, setInstruction] = useState(''),
    [selected, setSelected] = useState<readonly SourceVersionId[]>([])
  useEffect(() => {
    const recommended = state.recommendedSourceVersionId
    if (recommended !== null) setSelected(previous => [...new Set([...previous, recommended])])
  }, [state.recommendedSourceVersionId])
  const running = state.run?.status === 'pending' || state.run?.status === 'running'
  const outdated =
    state.creation?.basis.source === 'creation-context' &&
    state.profile !== null &&
    state.creation.basis.profileVersionIds[0] !== state.profile.id
  const locked =
    state.busy || state.syncing || state.uncertain || running || state.project?.draft.restricted || outdated
  const permittedSelection = selected.filter(versionId =>
    state.sources.some(source => source.versionId === versionId && source.authorized),
  )
  return (
    <section className={css.creation} aria-label={t('creation')}>
      <h2>{t('creation')}</h2>
      {!state.profile && <p role="status">{t('needProfile')}</p>}
      {state.modelConfigured === false && <p role="status">{t('needModel')}</p>}
      <fieldset disabled={locked}>
        <legend>{t('selectedSources')}</legend>
        {state.sources
          .filter(source => source.authorized)
          .map(source => (
            <label key={source.id} className={css.check}>
              <input
                type="checkbox"
                checked={permittedSelection.includes(source.versionId)}
                onChange={(event) => {
                  setSelected(
                    event.target.checked
                      ? [...permittedSelection, source.versionId]
                      : permittedSelection.filter(id => id !== source.versionId),
                  )
                }}
              />
              {source.title}
            </label>
          ))}
      </fieldset>
      <label>
        {t('instruction')}
        <textarea
          aria-label={t('instruction')}
          value={instruction}
          disabled={locked}
          onChange={(event) => {
            setInstruction(event.target.value)
          }}
        />
      </label>
      <div className={css.toolbar}>
        <Button
          variant="primary"
          disabled={locked || !state.profile || !instruction.trim() || state.modelConfigured === false}
          onClick={() => {
            void actions.generate(instruction, permittedSelection, state.text ? 'modify' : 'generate')
          }}
        >
          {t(state.text ? 'modify' : 'generate')}
        </Button>
        <Button
          disabled={locked || !selection || !state.profile || !instruction.trim() || state.modelConfigured === false}
          onClick={() => {
            if (selection) void actions.generate(instruction, permittedSelection, 'selection', selection)
          }}
        >
          {t('modifySelection')}
        </Button>
        {running && (
          <Button
            onClick={() => {
              void actions.cancelGeneration()
            }}
          >
            {t('stop')}
          </Button>
        )}
      </div>
      {selection && <p className={css.hint}>{t('selectionReady')}</p>}
      {state.run && (
        <p role="status" aria-live="polite">
          {t(`run.${state.run.status}`)}
          {state.run.status === 'failed' && (
            <> · {t(state.run.errorCode === 'timeout' ? 'timedOut' : 'generationFailed')}</>
          )}
        </p>
      )}
      {state.run?.status === 'failed' &&
        state.run.errorCode === 'draft-conflict' &&
        state.run.candidate &&
        !state.run.restricted && (
        <Button
          disabled={locked || state.dirty}
          onClick={() => {
            void actions.applyCandidate()
          }}
        >
          {t('applyCandidate')}
        </Button>
      )}
      <ol className={css.dialogue} aria-label={t('dialogue')}>
        {state.creation?.dialogue.map(message => (
          <li key={message.id}>
            <strong>{t(message.role === 'user' ? 'you' : 'assistant')}</strong>
            <p>{message.restricted ? t('restricted') : message.body}</p>
          </li>
        ))}
      </ol>
      {state.creation?.basis.source === 'creation-context' && (
        <p className={css.hint}>
          {t('basis')} · {state.creation.basis.profileVersionIds.length} {t('profile')} ·{' '}
          {state.creation.basis.materialVersionIds.length} {t('sources')}
        </p>
      )}
    </section>
  )
}
