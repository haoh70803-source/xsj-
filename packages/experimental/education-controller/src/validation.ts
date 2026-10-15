/** Strict external request parsing; byte bounds come from the selected repository. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ArtifactId,
  ArtifactVersionId,
  EducationResourceLimits,
  ProjectId,
  RequestId,
  SourceId,
  SourceVersionId,
  ProfileVersionId,
  RunId,
  ContentAccountId,
  MetricImportId,
  MetricSnapshotId,
  SyncRunId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const projectId = uuid.transform(value => brandString<ProjectId>(value))
const artifactId = uuid.transform(value => brandString<ArtifactId>(value))
const versionId = uuid.transform(value => brandString<ArtifactVersionId>(value))
const requestId = uuid.transform(value => brandString<RequestId>(value))
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/**
 * Construct validation for the actual provider's limits.
 * @param limits - effective byte and page bounds.
 * @returns exact schemas shared by Remote admission, methods and Fetch export.
 */
export function requestSchemas(limits: EducationResourceLimits): ReturnType<typeof buildSchemas> {
  return buildSchemas(limits)
}

function buildSchemas(limits: EducationResourceLimits) {
  const page = {
    limit: z.number().int().min(1).max(limits.maxPageSize),
    cursor: z.string().min(1).max(1024).optional(),
  }
  const content = z
    .string()
    .refine(value => value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= limits.maxBodyBytes)
  const sourceId = uuid.transform(value => brandString<SourceId>(value))
  const runId = uuid.transform(value => brandString<RunId>(value))
  const accountId = uuid.transform(value => brandString<ContentAccountId>(value)),
    syncRunId = uuid.transform(value => brandString<SyncRunId>(value))
  const account = { accountId },
    query = {
      ...account,
      mode: z.enum(['latest', 'seven-days']),
      source: z.string().min(1).max(300),
      keyword: z.string().max(limits.maxTitleBytes),
    }
  const permissions = z.strictObject({
    view: z.boolean(),
    sync: z.boolean(),
    manage: z.boolean(),
    export: z.boolean(),
    use_for_ai: z.boolean(),
  })
  return {
    analyticsAvailability: z.strictObject({}),
    analyticsAccountsList: z.strictObject({}),
    analyticsAccountCreate: z.strictObject({
      platform: z.enum(['douyin', 'xiaohongshu']),
      externalId: z.string().min(1).max(limits.maxTitleBytes),
      title: z.string().min(1).max(limits.maxTitleBytes),
      requestId,
    }),
    analyticsAccountSetGrant: z.strictObject({
      ...account,
      username: z.string().min(1).max(200),
      permissions,
      expectedRevision: revision,
      requestId,
    }),
    analyticsAccountSetEnabled: z.strictObject({
      ...account,
      enabled: z.boolean(),
      expectedRevision: revision,
      requestId,
    }),
    analyticsAccountGrants: z.strictObject(account),
    analyticsQuery: z.strictObject(query),
    analyticsExport: z.strictObject(query),
    analyticsImportPreview: z.strictObject({
      ...account,
      sourceLabel: z.string().min(1).max(limits.maxTitleBytes),
      observedAt: z.iso.datetime({ offset: true }),
      content: content.min(1),
      requestId,
    }),
    analyticsImportCommit: z.strictObject({
      importId: uuid.transform(value => brandString<MetricImportId>(value)),
      expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/),
      allowPartial: z.boolean(),
      requestId,
    }),
    analyticsMutationResult: z.strictObject({
      operation: z.enum(['accounts.create', 'accounts.enable', 'accounts.grant', 'imports.commit', 'schedules.save']),
      requestId,
    }),
    analyticsSyncRequest: z.strictObject({ ...account, mode: z.enum(['latest', 'seven-days']), requestId }),
    analyticsSyncFind: z.strictObject({ requestId }),
    analyticsSyncGet: z.strictObject({ runId: syncRunId }),
    analyticsSyncList: z.strictObject(account),
    analyticsSyncCancel: z.strictObject({ runId: syncRunId }),
    analyticsSyncReviewUnknown: z.strictObject({ runId: syncRunId, confirmed: z.literal(true) }),
    analyticsScheduleRead: z.strictObject(account),
    analyticsScheduleSave: z.strictObject({
      ...account,
      enabled: z.boolean(),
      hour: revision.max(23),
      minute: revision.max(59),
      timeZone: z.string().min(1).max(100),
      expectedRevision: revision,
      requestId,
    }),
    researchTransfer: z.strictObject({ artifactId, versionId, direction: revision, requestId }),
    analyticsTransfer: z.strictObject({
      projectId,
      snapshotId: uuid.transform(value => brandString<MetricSnapshotId>(value)),
      target: z.enum(['writing', 'research']),
      originalText: content,
      requestId,
    }),
    researchImportSource: z.strictObject({
      format: z.enum(['text', 'research-input-v1']),
      title: z
        .string()
        .min(1)
        .refine(value => value.isWellFormed() && Buffer.byteLength(value) <= limits.maxTitleBytes),
      content: content.min(1),
      sourceUrl: content,
      sourceId: sourceId.optional(),
      expectedRevision: revision,
      requestId,
      confirmed: z.literal(true),
    }),
    researchImportLegacy: z.strictObject({
      artifactId,
      text: content.min(1),
      originId: z.string().min(1).max(limits.maxTitleBytes),
      expectedDraftRevision: revision,
      expectedLatestVersionId: versionId.nullable(),
      requestId,
      confirmed: z.literal(true),
    }),
    researchReadSource: z.strictObject({ versionId: uuid.transform(value => brandString<SourceVersionId>(value)) }),
    researchEnsureArtifact: z.strictObject({ projectId, requestId }),
    researchOpen: z.strictObject({ artifactId }),
    researchReadVersion: z.strictObject({ artifactId, versionId }),
    researchStart: z.strictObject({
      artifactId,
      sourceVersionId: uuid.transform(value => brandString<SourceVersionId>(value)),
      expectedDraftRevision: revision,
      expectedLatestVersionId: versionId.nullable(),
      requestId,
      instruction: content,
    }),
    knowledgeSearch: z.strictObject({
      query: z.string().refine(value => value.isWellFormed() && Buffer.byteLength(value) <= limits.maxTitleBytes),
      kind: z.enum(['all', 'text', 'transcript']),
      ...page,
    }),
    knowledgeReadSourceVersion: z.strictObject({
      versionId: uuid.transform(value => brandString<SourceVersionId>(value)),
    }),
    profilesReadSelf: z.strictObject({}),
    profilesSaveVersion: z.strictObject({
      facts: content.min(1),
      preferences: content,
      prohibitedPromises: content,
      expectedRevision: revision,
      requestId,
    }),
    sourcesList: z.strictObject({}),
    sourcesSaveVersion: z.strictObject({
      sourceId: sourceId.optional(),
      expectedRevision: revision,
      title: z
        .string()
        .min(1)
        .refine(value => Buffer.byteLength(value) <= limits.maxTitleBytes),
      body: content.min(1),
      sourceUrl: content,
      requestId,
    }),
    sourcesSetAuthorization: z.strictObject({
      sourceId,
      authorized: z.boolean(),
      expectedAuthorizationRevision: revision,
      requestId,
    }),
    creationAvailability: z.strictObject({}),
    creationStart: z.strictObject({
      artifactId,
      requestId,
      expectedDraftRevision: revision,
      profileVersionId: uuid.transform(value => brandString<ProfileVersionId>(value)),
      sourceVersionIds: z.array(uuid.transform(value => brandString<SourceVersionId>(value))).max(limits.maxPageSize),
      instruction: content.min(1),
      mode: z.enum(['generate', 'modify', 'selection']),
      selection: z
        .strictObject({
          start: revision,
          end: revision,
          bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
          original: content,
        })
        .optional(),
    }),
    creationGetRun: z.strictObject({ runId }),
    creationFindRun: z.strictObject({ requestId }),
    creationCancel: z.strictObject({ runId }),
    creationReadState: z.strictObject({ artifactId }),
    creationResetContext: z.strictObject({ artifactId, expectedDraftRevision: revision, requestId }),
    creationMutationResult: z.strictObject({
      operation: z.enum(['profiles.save', 'sources.save', 'sources.authorize', 'context.reset']),
      requestId,
    }),
    creationApplyCandidate: z.strictObject({ runId, expectedDraftRevision: revision, requestId }),
    projectsCreate: z.strictObject({
      title: z
        .string()
        .refine(
          value =>
            value.isWellFormed() &&
            value.trim() !== '' &&
            Buffer.byteLength(value.trim(), 'utf8') <= limits.maxTitleBytes,
        ),
      scenario: z.enum(['spoken-script', 'moments']),
      requestId,
    }),
    projectsList: z.strictObject(page),
    projectsOpen: z.strictObject({ projectId }),
    projectsFollow: z.strictObject({ projectId }),
    draftsSync: z.strictObject({
      artifactId,
      body: z
        .string()
        .refine(
          value =>
            value.isWellFormed() && Buffer.byteLength(value.replaceAll('\r\n', '\n'), 'utf8') <= limits.maxBodyBytes,
        ),
      expectedDraftRevision: revision,
      requestId,
    }),
    artifactsSaveVersion: z.strictObject({
      artifactId,
      expectedDraftRevision: revision,
      expectedLatestVersionId: versionId.nullable(),
      requestId,
    }),
    artifactsListVersions: z.strictObject({ artifactId, ...page }),
    artifactsReadVersion: z.strictObject({ artifactId, versionId }),
    draftsRestoreVersion: z.strictObject({ artifactId, versionId, expectedDraftRevision: revision, requestId }),
    requestsGetResult: z.strictObject({
      operation: z.enum([
        'projects.create',
        'drafts.sync',
        'drafts.restoreVersion',
        'artifacts.saveVersion',
        'sessions.bind',
        'artifacts.create',
      ]),
      requestId,
    }),
    exportText: z.discriminatedUnion('target', [
      z.strictObject({ artifactId, target: z.literal('draft') }),
      z.strictObject({ artifactId, target: z.literal('version'), versionId }),
    ]),
  }
}

/**
 * Parse one external request without including its values in errors or logs.
 * @param schema - selected operation schema.
 * @param input - external decoded request.
 * @returns validated operation values.
 */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    throw new EducationError(
      'validation-failed',
      'request fields are invalid; check identifiers, limits and revision baselines',
    )
  return parsed.data
}
