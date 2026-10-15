/** Owned phase-C SQLite fixture; setup and cleanup use the real provider and verified local paths. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActorContext, OrganizationId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { SqliteEducationRepository } from '../src/repository.ts'
import { resolveConfig } from '../src/index.ts'
import { digest } from '../src/codec.ts'

export async function stageFixture() {
  const cache = fileURLToPath(new URL('../../../../.cache/education-stage-c-tests/', import.meta.url))
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'owned-')),
    path = join(root, 'business.sqlite')
  const repository = await SqliteEducationRepository.open(resolveConfig({ path }))
  const organizationId = repository.provisionOrganization('合成第三阶段组织')
  function employee(username: string, organization: OrganizationId = organizationId): ActorContext {
    const user = repository.provisionUser({
      organizationId: organization,
      usernameNormalized: username,
      credentialSalt: '1'.repeat(32),
      credentialHash: '2'.repeat(128),
    })
    const tokenHash = digest(username)
    repository.createLoginSession({
      organizationId: organization,
      userId: user.id,
      tokenHash,
      authRevision: 0,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const actor = repository.resolveLoginSession(tokenHash)
    if (actor === null) throw new Error('fixture login is missing')
    return actor
  }
  const a = employee('stage-owner'),
    b = employee('stage-other'),
    inspect = new DatabaseSync(path)
  return {
    root,
    path,
    repository,
    inspect,
    organizationId,
    a,
    b,
    employee,
    close() {
      inspect.close()
      repository.close()
      if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-')))
        throw new Error('fixture cleanup outside owned root')
      rmSync(root, { recursive: true, force: true })
    },
  }
}
