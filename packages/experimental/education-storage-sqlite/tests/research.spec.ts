/** Source-only research uses real shared transactions and formal versions; model objects here are explicit fixtures. */
import type { RequestId, ArtifactVersionId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ResearchDocument, SourceVersionId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { researchReport } from '../../education-platform/tests/research-fixture.ts'
import { stageFixture } from './stage-fixture.ts'
import { digest, newId } from '../src/codec.ts'

let f: Awaited<ReturnType<typeof stageFixture>>
beforeEach(async () => {
  f = await stageFixture()
})
afterEach(() => {
  f?.close()
})
const execution = { provider: 'synthetic', model: 'synthetic', maxTokens: 4096, maxAttempts: 2, timeoutMs: 10_000 }
function prepare() {
  const project = f.repository.createProject(f.a, {
    title: '合成同项目研究',
    scenario: 'spoken-script',
    requestId: newId<RequestId>(),
  })
  const source = f.repository.research.importSource(f.a, {
    format: 'text',
    title: '合成原文',
    content: '这是第一段合成原文，用于验证引用。\n\n这是第二段合成原文，说明前后关系。',
    sourceUrl: '',
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  })
  const ensured = f.repository.research.ensureArtifact(f.a, { projectId: project.projectId, requestId: newId<RequestId>() })
  const input = {
    artifactId: ensured.artifactId,
    sourceVersionId: source.versionId,
    expectedDraftRevision: 0,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
    instruction: '',
  }
  const run = f.repository.research.start(f.a, input, 'synthetic-research-policy', execution, 120_000)
  const snapshot = f.repository.creation.runInput(f.a, run.id)
  if (snapshot.scenario !== 'text-analysis') throw new Error('research acquired a writing profile')
  const document: ResearchDocument = {
    kind: 'research-report',
    version: 1,
    input: snapshot.input,
    report: researchReport(snapshot.input.evidence),
    generated: {
      runId: run.id,
      policyVersion: snapshot.policyVersion,
      provider: execution.provider,
      model: execution.model,
      createdAt: new Date().toISOString(),
    },
  }
  return { project, source, ensured, input, run, snapshot, document }
}

it('analyzes a source without a personal profile and preserves the project’s primary writing artifact', () => {
  const value = prepare()
  expect(f.repository.creation.readProfile(f.a)).toBeNull()
  expect(value.snapshot).not.toHaveProperty('profile')
  expect(f.repository.openProject(f.a, value.project.projectId).artifact.id).toBe(value.project.artifactId)
  const completed = f.repository.creation.complete(
    f.a,
    value.run.id,
    JSON.stringify(value.document),
    value.document.report.overview.takeaway,
  )
  expect(completed.status).toBe('completed')
  expect(f.repository.research.open(f.a, value.ensured.artifactId).document).toEqual(value.document)
  expect(f.repository.openProject(f.a, value.project.projectId).draft.body).toBe('')
  expect(f.repository.readArtifact(f.a, value.ensured.artifactId).latestVersionId).toBeNull()
})

it('imports legacy text only through its explicit envelope and retains the original result without model execution', () => {
  const project = f.repository.createProject(f.a, {
    title: '合成旧文导入',
    scenario: 'spoken-script',
    requestId: newId<RequestId>(),
  })
  const ensured = f.repository.research.ensureArtifact(f.a, { projectId: project.projectId, requestId: newId<RequestId>() })
  const request = {
    artifactId: ensured.artifactId,
    text: '合成旧版纯文本\r\n保留原文',
    originId: 'synthetic-old-report',
    expectedDraftRevision: 0,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
    confirmed: true as const,
  }
  const receipt = f.repository.research.importLegacy(f.a, request)
  expect(f.repository.research.importLegacy(f.a, request)).toEqual(receipt)
  expect(f.repository.research.open(f.a, ensured.artifactId).document).toEqual({
    kind: 'legacy-text',
    version: 1,
    text: '合成旧版纯文本\n保留原文',
    originId: request.originId,
  })
  const version = f.repository.saveVersion(f.a, {
    artifactId: ensured.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.readVersion(f.a, ensured.artifactId, version.versionId).basisSnapshot.source).toBe(
    'foundation-validation',
  )
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM creation_runs').get()?.n).toBe(0)
  expect(f.repository.openProject(f.a, project.projectId).draft.body).toBe('')
})

it('transfers a direction only from a saved validated report and preserves report/source authorization', () => {
  const value = prepare()
  f.repository.creation.complete(f.a, value.run.id, JSON.stringify(value.document), '合成说明')
  const saved = f.repository.saveVersion(f.a, {
    artifactId: value.ensured.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
  })
  const request = { artifactId: value.ensured.artifactId, versionId: saved.versionId, direction: 0, requestId: newId<RequestId>() }
  const source = f.repository.transfers.fromResearch(f.a, request)
  expect(source.purpose).toBe('reference-method')
  expect(source.body).toContain(saved.versionId)
  expect(f.repository.transfers.fromResearch(f.a, request).versionId).toBe(source.versionId)
  expect(f.repository.creation.readProfile(f.a)).toBeNull()
  f.repository.creation.authorizeSource(f.a, {
    sourceId: value.source.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.creation.listSources(f.a).find(item => item.id === source.id)).toMatchObject({
    authorized: false,
    body: '',
  })
  expect(() => f.repository.transfers.fromResearch(f.a, request)).toThrow('authority')
})

it('uses one same-key run and one same-project analysis artifact, while refusing changed retries and foreign access', () => {
  const value = prepare()
  expect(f.repository.research.start(f.a, value.input, 'synthetic-research-policy', execution, 120_000).id).toBe(
    value.run.id,
  )
  expect(() =>
    f.repository.research.start(
      f.a,
      { ...value.input, instruction: 'changed' },
      'synthetic-research-policy',
      execution,
      120_000,
    ),
  ).toThrow('different parameters')
  expect(() =>
    f.repository.research.start(
      f.a,
      { ...value.input, requestId: newId<RequestId>() },
      'synthetic-research-policy',
      execution,
      120_000,
    ),
  ).toThrow()
  expect(
    f.repository.research.ensureArtifact(f.a, { projectId: value.project.projectId, requestId: newId<RequestId>() }),
  ).toMatchObject({ artifactId: value.ensured.artifactId, created: false })
  expect(() => f.repository.research.open(f.b, value.ensured.artifactId)).toThrow('unavailable')
  expect(() => f.repository.research.readSource(f.b, value.source.versionId)).toThrow('unavailable')
})

it('stores complete report versions, blocks generic text writes and refuses corrupted historical report restoration', () => {
  const value = prepare()
  f.repository.creation.complete(f.a, value.run.id, JSON.stringify(value.document), '合成解释')
  expect(() =>
    f.repository.syncDraft(f.a, {
      artifactId: value.ensured.artifactId,
      body: '非法通用编辑器写入',
      expectedDraftRevision: 1,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('plain-text editor')
  const saved = f.repository.saveVersion(f.a, {
    artifactId: value.ensured.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
  })
  expect(JSON.parse(f.repository.readVersion(f.a, value.ensured.artifactId, saved.versionId).body)).toMatchObject({
    kind: 'research-report',
    report: { schema_version: 2 },
  })
  const invalidId = newId(),
    invalidBody = '不是结构化报告',
    basis = f.repository.creation.basis(f.a, value.ensured.artifactId)
  f.inspect
    .prepare('INSERT INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      invalidId,
      value.ensured.artifactId,
      f.organizationId,
      f.a.userId,
      2,
      invalidBody,
      digest(invalidBody),
      JSON.stringify(basis),
      f.a.userId,
      new Date().toISOString(),
    )
  expect(() =>
    f.repository.restoreVersion(f.a, {
      artifactId: value.ensured.artifactId,
      versionId: brandString<ArtifactVersionId>(invalidId),
      expectedDraftRevision: 1,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('stored research report is invalid')
  expect(f.repository.research.open(f.a, value.ensured.artifactId).draft.revision).toBe(1)
})

it('rejects a false quote or forged model/source metadata without committing a candidate or formal version', () => {
  const value = prepare()
  const bad = {
    ...value.document,
    report: {
      ...value.document.report,
      propagation: { summary: '合成错误', evidence: [{ source_id: 'p_0000', quote: '作者从未说过的句子。' }] },
    },
  }
  expect(() => f.repository.creation.complete(f.a, value.run.id, JSON.stringify(bad), '')).toThrow('evidence checks')
  expect(() =>
    f.repository.creation.complete(
      f.a,
      value.run.id,
      JSON.stringify({ ...value.document, generated: { ...value.document.generated, model: 'forged-model' } }),
      '',
    ),
  ).toThrow('metadata differs')
  expect(f.repository.research.open(f.a, value.ensured.artifactId)).toMatchObject({
    draft: { body: '', revision: 0 },
    latestVersion: null,
  })
})

it('records sequential bounded repair attempts and cannot retry an unsettled or uncertain attempt', () => {
  const value = prepare(),
    first = f.repository.research.prepareAttempt(f.a, value.run.id, 1, digest('first full prompt'))
  expect(f.repository.research.prepareAttempt(f.a, value.run.id, 1, digest('first full prompt'))).toEqual(first)
  expect(() => f.repository.research.prepareAttempt(f.a, value.run.id, 1, digest('changed prompt'))).toThrow(
    'prompt changed',
  )
  expect(() => f.repository.research.prepareAttempt(f.a, value.run.id, 2, digest('repair prompt'))).toThrow('unsettled')
  f.repository.research.finishAttempt(f.a, value.run.id, 1, brandString<SessionId>('synthetic-session-one'), 'failed', [
    'sections.0: missing evidence',
  ])
  expect(f.repository.research.prepareAttempt(f.a, value.run.id, 2, digest('repair prompt')).attempt).toBe(2)
  expect(() => f.repository.research.prepareAttempt(f.a, value.run.id, 3, digest('third prompt'))).toThrow(
    'captured limits',
  )
})

it('applies current source grants to every repair Session, including a no-longer-current attempt', () => {
  const value = prepare(),
    first = f.repository.research.prepareAttempt(f.a, value.run.id, 1, digest('first prompt'))
  const firstSession = brandString<SessionId>('synthetic-first-private-session'),
    secondSession = brandString<SessionId>('synthetic-second-private-session')
  f.repository.bindSession(f.a, {
    projectId: value.project.projectId,
    artifactId: value.ensured.artifactId,
    harnessSessionId: firstSession,
    requestId: first.bindingRequestId,
  })
  f.repository.research.finishAttempt(f.a, value.run.id, 1, firstSession, 'failed', [
    'propagation.evidence: invalid quote',
  ])
  const second = f.repository.research.prepareAttempt(f.a, value.run.id, 2, digest('repair prompt'))
  f.repository.bindSession(f.a, {
    projectId: value.project.projectId,
    artifactId: value.ensured.artifactId,
    harnessSessionId: secondSession,
    requestId: second.bindingRequestId,
  })
  f.repository.research.finishAttempt(f.a, value.run.id, 2, secondSession, 'running', [])
  f.repository.creation.markRunning(f.a, value.run.id, secondSession)
  expect(f.repository.getSessionBinding(f.a, firstSession).harnessSessionId).toBe(firstSession)
  f.repository.creation.authorizeSource(f.a, {
    sourceId: value.source.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(() => f.repository.getSessionBinding(f.a, firstSession)).toThrow('unavailable')
  expect(() => f.repository.getSessionBinding(f.a, secondSession)).toThrow('unavailable')
})

it('keeps historical source bytes after correction and hides reports when the source is revoked', () => {
  const value = prepare()
  f.repository.creation.complete(f.a, value.run.id, JSON.stringify(value.document), '合成解释')
  const saved = f.repository.saveVersion(f.a, {
    artifactId: value.ensured.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
  })
  f.repository.research.importSource(f.a, {
    format: 'text',
    title: '校对新版本',
    content: '这是明确校对过的新原文。',
    sourceUrl: '',
    sourceId: value.source.id,
    expectedRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.research.readSource(f.a, value.source.versionId).source.body).toBe(value.source.body)
  expect(f.repository.readVersion(f.a, value.ensured.artifactId, saved.versionId).body).toContain(
    value.source.body.split('\n')[0],
  )
  f.repository.creation.authorizeSource(f.a, {
    sourceId: value.source.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.research.open(f.a, value.ensured.artifactId)).toMatchObject({
    draft: { body: '', restricted: true },
    document: null,
  })
  expect(f.repository.readVersion(f.a, value.ensured.artifactId, saved.versionId)).toMatchObject({
    body: '',
    restricted: true,
  })
})

it('imports V1 evidence atomically and retains distinct object/file digests, original title and zero metadata', () => {
  const vector = z
    .object({ vectors: z.array(z.object({ raw: z.string() })).min(1) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL('../../education-platform/tests/fixtures/research-v1-python.json', import.meta.url),
          'utf8',
        ),
      ),
    ).vectors[0]
  if (vector === undefined) throw new Error('Python V1 vector is missing')
  const request = {
    format: 'research-input-v1',
    title: '本人资料标签',
    content: vector.raw,
    sourceUrl: '',
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  } as const
  const source = f.repository.research.importSource(f.a, request),
    opened = f.repository.research.readSource(f.a, source.versionId)
  expect(opened.origin.originalTitle).toBe('合成输入验收')
  expect(opened.origin.fileSha256).not.toBe(opened.origin.transcriptObjectSha256)
  expect(opened.origin.videoInfo).toMatchObject({ followers: 0, likes: null })
  expect(f.repository.research.importSource(f.a, request).versionId).toBe(source.versionId)
  expect(() => f.repository.research.importSource(f.a, { ...request, content: vector.raw + ' ' })).toThrow(
    'different values',
  )
  expect(() =>
    f.inspect.prepare('UPDATE source_evidence SET evidence_json=? WHERE version_id=?').run('{}', source.versionId),
  ).toThrow('immutable source evidence')
})

it('retains the last report on a revoked or stale running context and releases occupancy on failure', () => {
  const value = prepare()
  f.repository.creation.authorizeSource(f.a, {
    sourceId: value.source.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.creation.complete(f.a, value.run.id, JSON.stringify(value.document), '')).toMatchObject({
    status: 'failed',
    restricted: true,
    candidate: null,
  })
  expect(f.repository.research.open(f.a, value.ensured.artifactId).draft.body).toBe('')
  expect(() =>
    f.repository.research.start(
      f.a,
      { ...value.input, sourceVersionId: brandString<SourceVersionId>(newId()), requestId: newId<RequestId>() },
      'policy',
      execution,
      120_000,
    ),
  ).toThrow()
})
