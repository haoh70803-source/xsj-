/** Client-only carrier answers. Real Host behavior is covered by the Loader tests. */
import { vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectFollowFrame } from '@deepseek-ai/dsh-experimental-education-controller/types'
import type {
  ArtifactId,
  ArtifactVersionDTO,
  ArtifactVersionId,
  OrganizationId,
  ProjectId,
  ProjectState,
  RequestId,
  UserDTO,
  UserId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { EducationWorkspace, type EducationRemote, type WorkspaceTransport } from '../src/client/model.ts'
import type {
  ProfileVersion,
  ProfileVersionId,
  RunDTO,
  RunId,
  SourceDTO,
  SourceId,
  SourceVersionId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

export const user: UserDTO = {
  id: brandString<UserId>('user-a'),
  organizationId: brandString<OrganizationId>('org'),
  username: 'employee-a',
}
export const other: UserDTO = { ...user, id: brandString<UserId>('user-b'), username: 'employee-b' }
export const projectId = brandString<ProjectId>('project-a')
export const artifactId = brandString<ArtifactId>('artifact-a')
export const versionId = brandString<ArtifactVersionId>('version-1')
export const version: ArtifactVersionDTO = {
  id: versionId,
  artifactId,
  versionNo: 1,
  body: 'immutable first version',
  bodyHash: 'v1hash',
  savedBy: user.id,
  savedAt: '2026-10-15T00:00:00.000Z',
  basisSnapshot: { source: 'foundation-validation', profileVersionIds: [], materialVersionIds: [] },
}
export const state: ProjectState = {
  project: {
    id: projectId,
    title: 'My private project',
    scenario: 'spoken-script',
    primaryArtifactId: artifactId,
    createdAt: version.savedAt,
    updatedAt: version.savedAt,
  },
  artifact: {
    id: artifactId,
    projectId,
    kind: 'spoken-script',
    latestVersionId: versionId,
    createdAt: version.savedAt,
    updatedAt: version.savedAt,
  },
  draft: { artifactId, body: 'server draft', revision: 4, bodyHash: 'draft4', updatedAt: version.savedAt },
  latestVersion: version,
  sessionBindings: [],
}
export const profile: ProfileVersion = {
  id: brandString<ProfileVersionId>('profile-1'),
  revision: 1,
  facts: 'confirmed synthetic facts',
  preferences: '',
  prohibitedPromises: '',
  bodyHash: 'profilehash',
  createdAt: version.savedAt,
}
export const source: SourceDTO = {
  id: brandString<SourceId>('source-1'),
  title: 'synthetic source',
  sourceUrl: '',
  revision: 1,
  authorizationRevision: 1,
  authorized: true,
  versionId: brandString<SourceVersionId>('source-version-1'),
  body: 'synthetic source text',
  bodyHash: 'sourcehash',
  createdAt: version.savedAt,
}
export const run: RunDTO = {
  id: brandString<RunId>('run-1'),
  requestId: brandString<RequestId>('creation-request'),
  artifactId,
  projectId,
  status: 'pending',
  expectedDraftRevision: 4,
  draftRevision: null,
  errorCode: null,
  candidate: null,
  explanation: null,
  restricted: false,
  sessionId: null,
  contextFingerprint: 'fingerprint',
  createdAt: version.savedAt,
  updatedAt: version.savedAt,
}
export const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function fixture(options?: ConstructorParameters<typeof EducationWorkspace>[1]) {
  const ended = deferred<IteratorResult<ProjectFollowFrame>>()
  const stream = {
    send() {},
    end() {},
    dispose: vi.fn(() => {
      ended.resolve({ done: true, value: undefined })
    }),
    [Symbol.asyncIterator]: () => ({ next: () => ended.promise }),
  } satisfies RemoteStreamHandle<ProjectFollowFrame, never>
  const remote = {
    researchImportLegacy: vi
      .fn<EducationRemote['researchImportLegacy']>()
      .mockResolvedValue(
        ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'legacy', updatedAt: version.savedAt }),
      ),
    analyticsAvailability: vi
      .fn<EducationRemote['analyticsAvailability']>()
      .mockResolvedValue(ok({ enabled: false, configured: false, platforms: [] })),
    analyticsAccountsList: vi.fn<EducationRemote['analyticsAccountsList']>().mockResolvedValue(ok([])),
    analyticsAccountCreate: vi.fn<EducationRemote['analyticsAccountCreate']>(),
    analyticsAccountSetGrant: vi.fn<EducationRemote['analyticsAccountSetGrant']>(),
    analyticsAccountSetEnabled: vi.fn<EducationRemote['analyticsAccountSetEnabled']>(),
    analyticsAccountGrants: vi.fn<EducationRemote['analyticsAccountGrants']>().mockResolvedValue(ok([])),
    analyticsQuery: vi.fn<EducationRemote['analyticsQuery']>(),
    analyticsExport: vi.fn<EducationRemote['analyticsExport']>(),
    analyticsImportPreview: vi.fn<EducationRemote['analyticsImportPreview']>(),
    analyticsImportCommit: vi.fn<EducationRemote['analyticsImportCommit']>(),
    analyticsMutationResult: vi.fn<EducationRemote['analyticsMutationResult']>().mockResolvedValue(ok(null)),
    analyticsSyncRequest: vi.fn<EducationRemote['analyticsSyncRequest']>(),
    analyticsSyncFind: vi.fn<EducationRemote['analyticsSyncFind']>().mockResolvedValue(ok(null)),
    analyticsSyncGet: vi.fn<EducationRemote['analyticsSyncGet']>(),
    analyticsSyncList: vi.fn<EducationRemote['analyticsSyncList']>().mockResolvedValue(ok([])),
    analyticsSyncCancel: vi.fn<EducationRemote['analyticsSyncCancel']>(),
    analyticsSyncReviewUnknown: vi.fn<EducationRemote['analyticsSyncReviewUnknown']>(),
    analyticsScheduleRead: vi.fn<EducationRemote['analyticsScheduleRead']>().mockResolvedValue(ok(null)),
    analyticsScheduleSave: vi.fn<EducationRemote['analyticsScheduleSave']>(),
    researchTransfer: vi.fn<EducationRemote['researchTransfer']>().mockResolvedValue(ok(source)),
    analyticsTransfer: vi.fn<EducationRemote['analyticsTransfer']>().mockResolvedValue(ok(source)),
    researchImportSource: vi.fn<EducationRemote['researchImportSource']>().mockResolvedValue(ok(source)),
    researchReadSource: vi
      .fn<EducationRemote['researchReadSource']>()
      .mockResolvedValue(
        ok({
          source,
          evidence: {
            kind: 'text',
            units: [{ id: 'p_0000', text: source.body, startOffset: 0, endOffset: source.body.length }],
          },
          origin: {
            originalTitle: null,
            externalSourceId: null,
            sourceUrl: '',
            fileSha256: null,
            transcriptObjectSha256: null,
            videoInfo: {},
          },
        }),
      ),
    researchEnsureArtifact: vi
      .fn<EducationRemote['researchEnsureArtifact']>()
      .mockResolvedValue(
        ok({
          operation: 'artifacts.create',
          projectId,
          primaryArtifactId: artifactId,
          artifactId,
          kind: 'text-analysis',
          draftRevision: 0,
          created: true,
        }),
      ),
    researchOpen: vi
      .fn<EducationRemote['researchOpen']>()
      .mockResolvedValue(
        ok({
          projectId,
          primaryArtifactId: artifactId,
          artifact: { ...state.artifact, kind: 'text-analysis' },
          draft: { ...state.draft, body: '' },
          latestVersion: null,
          document: null,
        }),
      ),
    researchReadVersion: vi
      .fn<EducationRemote['researchReadVersion']>()
      .mockResolvedValue(ok({ version, document: null, restricted: false })),
    researchStart: vi.fn<EducationRemote['researchStart']>().mockResolvedValue(ok(run)),
    knowledgeSearch: vi.fn<EducationRemote['knowledgeSearch']>().mockResolvedValue(ok({ items: [], nextCursor: null })),
    knowledgeReadSourceVersion: vi.fn<EducationRemote['knowledgeReadSourceVersion']>().mockResolvedValue(ok(source)),
    profilesReadSelf: vi.fn<EducationRemote['profilesReadSelf']>().mockResolvedValue(ok(profile)),
    profilesSaveVersion: vi
      .fn<EducationRemote['profilesSaveVersion']>()
      .mockResolvedValue(ok({ ...profile, revision: 2 })),
    sourcesList: vi.fn<EducationRemote['sourcesList']>().mockResolvedValue(ok([source])),
    sourcesSaveVersion: vi.fn<EducationRemote['sourcesSaveVersion']>().mockResolvedValue(ok(source)),
    sourcesSetAuthorization: vi
      .fn<EducationRemote['sourcesSetAuthorization']>()
      .mockResolvedValue(ok({ ...source, authorized: false, body: '', authorizationRevision: 2 })),
    creationAvailability: vi
      .fn<EducationRemote['creationAvailability']>()
      .mockResolvedValue(ok({ configured: true, provider: 'synthetic', model: 'synthetic' })),
    creationStart: vi.fn<EducationRemote['creationStart']>().mockResolvedValue(ok(run)),
    creationGetRun: vi.fn<EducationRemote['creationGetRun']>().mockResolvedValue(ok(run)),
    creationFindRun: vi.fn<EducationRemote['creationFindRun']>().mockResolvedValue(ok(null)),
    creationResetContext: vi
      .fn<EducationRemote['creationResetContext']>()
      .mockResolvedValue(
        ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'empty', updatedAt: version.savedAt }),
      ),
    creationMutationResult: vi.fn<EducationRemote['creationMutationResult']>().mockResolvedValue(ok(null)),
    creationCancel: vi.fn<EducationRemote['creationCancel']>().mockResolvedValue(ok({ ...run, status: 'cancelled' })),
    creationReadState: vi
      .fn<EducationRemote['creationReadState']>()
      .mockResolvedValue(
        ok({
          run: null,
          dialogue: [],
          restricted: false,
          basis: { source: 'foundation-validation', profileVersionIds: [], materialVersionIds: [] },
        }),
      ),
    creationApplyCandidate: vi
      .fn<EducationRemote['creationApplyCandidate']>()
      .mockResolvedValue(ok({ ...run, status: 'completed' })),
    projectsList: vi
      .fn<EducationRemote['projectsList']>()
      .mockResolvedValue(ok({ items: [state.project], nextCursor: null })),
    projectsOpen: vi.fn<EducationRemote['projectsOpen']>().mockResolvedValue(ok(state)),
    projectsCreate: vi
      .fn<EducationRemote['projectsCreate']>()
      .mockResolvedValue(ok({ operation: 'projects.create', projectId, artifactId, draftRevision: 0 })),
    projectsFollow: vi.fn<EducationRemote['projectsFollow']>().mockReturnValue(stream),
    draftsSync: vi
      .fn<EducationRemote['draftsSync']>()
      .mockResolvedValue(
        ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'draft5', updatedAt: version.savedAt }),
      ),
    artifactsSaveVersion: vi
      .fn<EducationRemote['artifactsSaveVersion']>()
      .mockResolvedValue(
        ok({ operation: 'artifacts.saveVersion', artifactId, versionId, versionNo: 2, draftRevision: 5 }),
      ),
    artifactsListVersions: vi
      .fn<EducationRemote['artifactsListVersions']>()
      .mockResolvedValue(ok({ items: [version], nextCursor: null })),
    artifactsReadVersion: vi.fn<EducationRemote['artifactsReadVersion']>().mockResolvedValue(ok(version)),
    draftsRestoreVersion: vi
      .fn<EducationRemote['draftsRestoreVersion']>()
      .mockResolvedValue(
        ok({
          operation: 'drafts.restoreVersion',
          artifactId,
          revision: 5,
          bodyHash: version.bodyHash,
          updatedAt: version.savedAt,
        }),
      ),
    requestsGetResult: vi.fn<EducationRemote['requestsGetResult']>().mockResolvedValue(ok(null)),
  } satisfies EducationRemote
  let sequence = 0
  const transport = {
    remote,
    identity: vi.fn<WorkspaceTransport['identity']>().mockResolvedValue(user),
    download: vi
      .fn<WorkspaceTransport['download']>()
      .mockResolvedValue(new Blob(['server draft'], { type: 'text/plain' })),
    requestId: () => brandString<RequestId>(`request-${++sequence}`),
  } satisfies WorkspaceTransport
  const model = new EducationWorkspace(transport, options)
  return { model, remote, transport, stream }
}
