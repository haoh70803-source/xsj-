/** Optional native employee panel; generated Remote descriptors are mounted only here. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import educationRemote from '@deepseek-ai/dsh-experimental-education-controller/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EducationWorkspace } from './model.ts'
import { createTransport } from './transport.ts'
import { EducationNotice, EducationPanelIcon } from './panel.tsx'
import { WorkbenchPanel, type WorkbenchFace } from './workbench-panel.tsx'
import { StageWorkspace } from './stage-model.ts'
import { en, zh, type EducationKey } from './locales.ts'
import { Config } from '../configuration.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Employee writing workspace copy. */ education: EducationKey
  }
}
/** Native services consumed by this optional surface. */
export const inject = ['remote', 'slots', 'locale']
/** Install data, native slot entries and reversible browser lifecycle observers. */
export async function apply(
  ctx: Context,
  config: {
    autoSyncDelayMs?: number
    runPollIntervalMs?: number
    maxTextFileBytes?: number
    contextRefreshIntervalMs?: number
  } = {},
): Promise<void> {
  const resolved = Config(config) as {
    autoSyncDelayMs: number
    runPollIntervalMs: number
    maxTextFileBytes: number
    contextRefreshIntervalMs: number
  }
  const unmount = await ctx.remote.$mount(educationRemote)
  ctx.effect(() => unmount, 'education-shell: generated Remote')
  ctx.inject(['remote', 'remote.education', 'slots', 'locale'], scoped => install(scoped, resolved))
}
async function install(
  ctx: Context,
  config: {
    autoSyncDelayMs: number
    runPollIntervalMs: number
    maxTextFileBytes: number
    contextRefreshIntervalMs: number
  },
): Promise<void> {
  ctx.effect(() => ctx.locale.register('education', { zh, en }), 'education-shell: dictionaries')
  const t = ctx.locale.bind('education')
  const model = new EducationWorkspace(createTransport(ctx.remote.education), config)
  const stageModel = new StageWorkspace(
    createTransport(ctx.remote.education),
    {
      useWritingSource: async (source) => {
        const generation = model.getSnapshot().generation
        await model.refreshContext()
        if (model.getSnapshot().generation === generation) model.recommendSource(source.versionId)
      },
      changed: () => {
        contextChanged()
      },
    },
    config.runPollIntervalMs,
  )
  ctx.effect(
    () =>
      model.subscribe(() => {
        const state = model.getSnapshot()
        stageModel.setOwner(
          state.user === null ? '' : `${state.generation}:${state.user.organizationId}:${state.user.id}`,
          state.project?.project.id ?? null,
        )
      }),
    'education: four-entry identity fence',
  )
  ctx.effect(
    () => () => {
      model.dispose()
      stageModel.dispose()
    },
    'education-shell: private data',
  )
  let identityChanged = (): void => {}
  let contextChanged = (): void => {}
  const face: WorkbenchFace = {
    stage: {
      importLegacy: (text, originId) => stageModel.importLegacy(text, originId),
      navigate: entry => stageModel.navigate(entry),
      search: (query, more) => stageModel.search(query, more),
      selectSource: id => stageModel.selectSource(id),
      useSource: id => stageModel.useSource(id),
      importSource: input => stageModel.importSource(input),
      authorizeSource: authorized => stageModel.authorizeSource(authorized),
      openResearch: create => stageModel.openResearch(create),
      analyze: instruction => stageModel.analyze(instruction),
      cancelResearch: () => stageModel.cancelResearch(),
      saveResearch: () => stageModel.saveResearch(),
      versions: more => stageModel.versions(more),
      previewReport: id => stageModel.previewReport(id),
      restoreReport: () => stageModel.restoreReport(),
      exportResearch: copy => stageModel.exportResearch(copy),
      transferResearch: index => stageModel.transferResearch(index),
      accounts: () => stageModel.accounts(),
      selectAccount: (id, reset) => stageModel.selectAccount(id, reset),
      createAccount: input => stageModel.createAccount(input),
      queryAnalytics: query => stageModel.queryAnalytics(query),
      previewImport: input => stageModel.previewImport(input),
      confirmImport: partial => stageModel.confirmImport(partial),
      grant: input => stageModel.grant(input),
      enableAccount: enabled => stageModel.enableAccount(enabled),
      sync: mode => stageModel.sync(mode),
      stopSync: (run, reviewed) => stageModel.stopSync(run, reviewed),
      schedule: input => stageModel.schedule(input),
      exportAnalytics: () => stageModel.exportAnalytics(),
      transferAnalytics: (id, target, text) => stageModel.transferAnalytics(id, target, text),
      resolve: retry => stageModel.resolve(retry),
    },
    saveProfile: async (content) => {
      await model.saveProfile(content)
      contextChanged()
    },
    saveSource: async (content) => {
      await model.saveSource(content)
      contextChanged()
    },
    authorizeSource: async (source, authorized) => {
      await model.authorizeSource(source, authorized)
      contextChanged()
    },
    refreshContext: () => model.refreshContext(),
    generate: (instruction, sources, mode, selection) => model.generate(instruction, sources, mode, selection),
    cancelGeneration: () => model.cancelGeneration(),
    applyCandidate: () => model.applyCandidate(),
    setComposing: (value) => {
      model.setComposing(value)
    },
    maxTextFileBytes: config.maxTextFileBytes,
    resetContext: () => model.resetContext(),
    hooks: { education: model, stageC: stageModel },
    authenticate: async (credentials) => {
      if (credentials) identityChanged()
      await model.authenticate(credentials)
      await model.refreshContext()
      if (credentials) identityChanged()
    },
    signOut: async () => {
      identityChanged()
      await model.signOut()
      identityChanged()
    },
    list: more => model.list(more),
    open: async (id, discard) => {
      await model.open(id, discard)
      await model.refreshCreation()
    },
    create: async (title, discard, scenario) => {
      await model.create(title, discard, scenario)
      await model.refreshCreation()
    },
    edit: (text) => {
      model.edit(text)
    },
    sync: () => model.sync(),
    save: () => model.save(),
    versions: more => model.versions(more),
    preview: version => model.preview(version),
    restore: discard => model.restore(discard),
    resolve: retry => model.resolve(retry),
    exportText: target =>
      model.export(target, (blob) => {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = target === 'draft' ? 'education-draft.txt' : 'education-version.txt'
        link.click()
        URL.revokeObjectURL(url)
      }),
    dismissNotice: () => {
      model.dismissNotice()
    },
  }
  const panel = brandString<MainPanelId>('education')
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      { name: 'main', key: panel, locale: 'education', inject: () => face },
      WorkbenchPanel,
    )
    if (ctx.get('uiWorkspace') === undefined) {
      ctx.get('layout')?.selectPanel(panel)
      ctx.get('layout')?.toggleSidebar()
    }
    return dispose
  })
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: panel,
        order: -10,
        label: () => t('panel'),
        locale: 'education',
      },
      EducationPanelIcon,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'education.notice',
        locale: 'education',
        inject: () => ({ hooks: face.hooks, dismissNotice: face.dismissNotice }),
      },
      EducationNotice,
    ),
  )
  ctx.on('connection/reset', () => {
    void model.checkIdentity()
  })
  ctx.effect(() => {
    const focus = (): void => {
      void (async () => {
        await model.checkIdentity()
        await model.refreshContext()
        await stageModel.refresh()
      })()
    }
    const leaving = (event: BeforeUnloadEvent): void => {
      if (model.getSnapshot().dirty || model.getSnapshot().uncertain || stageModel.getSnapshot().uncertain)
        event.preventDefault()
    }
    window.addEventListener('focus', focus)
    window.addEventListener('beforeunload', leaving)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('education.identity')
    const contextChannel =
      typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('education.context')
    identityChanged = () => {
      channel?.postMessage('changed')
    }
    if (channel)
      channel.onmessage = () => {
        model.invalidate()
      }
    contextChanged = () => {
      contextChannel?.postMessage('changed')
    }
    if (contextChannel)
      contextChannel.onmessage = () => {
        void model.refreshContext()
        void stageModel.refresh()
      }
    const contextTimer = setInterval(() => {
      const state = model.getSnapshot()
      if (
        document.visibilityState === 'visible' &&
        !state.busy &&
        !state.uncertain &&
        state.creation?.basis.source === 'creation-context'
      )
        void model.refreshCreation()
      if (document.visibilityState === 'visible') void stageModel.refresh()
    }, config.contextRefreshIntervalMs)
    return () => {
      identityChanged = () => {}
      contextChanged = () => {}
      channel?.close()
      contextChannel?.close()
      clearInterval(contextTimer)
      window.removeEventListener('focus', focus)
      window.removeEventListener('beforeunload', leaving)
    }
  }, 'education-shell: identity and page lifecycle')
  await model.authenticate()
  await model.refreshContext()
}
