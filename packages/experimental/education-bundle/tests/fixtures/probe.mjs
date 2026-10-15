/** Test-only plugin driven after the real dsh profile reports readiness; never calls a model. */
import { createHash, randomUUID } from 'node:crypto'

export const name = 'education-foundation-test-probe'
export const inject = ['educationPlatform', 'appReady', 'appExit']

export function apply(ctx) {
  const exit = ctx.appExit
  const logger = ctx.logger
  ctx.effect(() => ctx.appReady.onReady(() => {
    void verify(ctx).then(
      () => exit(0),
      error => { logger.error(error); exit(1) },
    )
  }), 'education-foundation-test: readiness probe')
}

async function verify(ctx) {
  const repository = ctx.educationPlatform.repository
  if (repository.schemaVersion !== 2) throw new Error('foundation schema did not become ready')
  const organizationId = repository.provisionOrganization('合成 Loader 测试组织')
  const actors = ['loader-a', 'loader-b'].map(username => {
    const user = repository.provisionUser({ organizationId, usernameNormalized: username,
      credentialHash: '1'.repeat(128), credentialSalt: '2'.repeat(32) })
    const tokenHash = createHash('sha256').update(`synthetic-token:${username}`).digest('hex')
    repository.createLoginSession({ organizationId, userId: user.id, tokenHash, authRevision: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const actor = repository.resolveLoginSession(tokenHash)
    if (actor === null) throw new Error('durable test login was not resolved')
    return actor
  })
  const [a, b] = actors
  const project = repository.createProject(a, { title: 'Loader 合成项目 A', scenario: 'spoken-script', requestId: randomUUID() })
  repository.syncDraft(a, { artifactId: project.artifactId, body: 'LOADER_SYNTHETIC_PRIVATE_A', expectedDraftRevision: 0, requestId: randomUUID() })
  const version = repository.saveVersion(a, { artifactId: project.artifactId,
    expectedDraftRevision: 1, expectedLatestVersionId: null, requestId: randomUUID() })
  repository.createProject(b, { title: 'Loader 合成项目 B', scenario: 'spoken-script', requestId: randomUUID() })
  let denied = false
  try { repository.openProject(b, project.projectId) }
  catch (error) { if (error.code === 'resource-unavailable') denied = true; else throw error }
  if (!denied || repository.listProjects(b, { limit: 10 }).items.length !== 1) throw new Error('repository owner isolation failed')
  const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'education-storage-sqlite')
  if (provider?.fiber === undefined) throw new Error('storage provider Loader entry was not active')
  await provider.fiber.dispose()
  let closed = false
  try { repository.listProjects(a, { limit: 10 }) }
  catch (error) { if (error.code === 'closed') closed = true; else throw error }
  if (!closed || ctx.get('educationRepository') !== undefined || ctx.get('educationPlatform') !== undefined) {
    throw new Error('provider unload did not remove and close the foundation')
  }
  process.stdout.write(`EDUCATION_FOUNDATION_PROBE ${JSON.stringify({
    isolated: true, closed: true, versionNo: version.versionNo,
    projectId: project.projectId, artifactId: project.artifactId, versionId: version.versionId,
  })}\n`)
}
