/** Actual employee cookies and HTTP bodies through the selected dsh Profile and identity layer. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_SCHEMA, dump, Type } from 'js-yaml'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { resolveConfig } from '../../education-storage-sqlite/src/index.ts'
import { SqliteEducationRepository } from '../../education-storage-sqlite/src/repository.ts'
import { createPasswordCredential } from '../../education-identity/src/credentials.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cache = join(repositoryRoot, '.cache', 'education-identity-loader-tests')
const probe = pathToFileURL(fileURLToPath(new URL('./fixtures/identity-probe.mjs', import.meta.url))).href

class JsExpression {
  constructor(readonly source: string) {}
}
const yamlSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', instanceOf: JsExpression,
  represent: (expression: object) => {
    if (!(expression instanceof JsExpression)) throw new Error('unexpected YAML expression value')
    return expression.source
  },
})])

it.each(['src', 'lib'] as const)('authenticates two employees and unloads HTTP routes through dsh (%s)', { timeout: 45_000 }, async (mode) => {
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'owned-'))
  const databasePath = join(root, 'business.sqlite')
  const patch = join(root, 'identity.patch.yml')
  const repository = await SqliteEducationRepository.open(resolveConfig({ path: databasePath }))
  try {
    const organizationId = repository.provisionOrganization('合成原生身份组合组织')
    const credential = await createPasswordCredential('synthetic-profile-identity-password')
    for (const usernameNormalized of ['identity-a', 'identity-b', 'identity-c']) repository.provisionUser({ organizationId, usernameNormalized, ...credential })
    repository.close()
    writeFileSync(patch, dump([
      { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
      { id: 'education-identity-layer', disabled: false },
      { id: 'education-controller', disabled: false, config: { maxFollowers: 1 } },
      { id: 'education-auth-webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'education-identity', inject: ['webServer'], config: {
        organizationId, publicOrigin: new JsExpression("'http://127.0.0.1:' + ctx.webServer.port"),
        adaptConnection: true,
      } },
      { insert: [
        { id: 'education-test-connection', name: pathToFileURL(join(repositoryRoot, 'packages/client/connection',
          mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href, config: { requireRequestPolicy: true } },
        { id: 'education-test-file-uploads', name: pathToFileURL(join(repositoryRoot, 'packages/client/file-upload',
          mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href },
        { id: 'education-test-workspace', name: pathToFileURL(join(repositoryRoot, 'packages/workspace/workspace',
          mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href },
        { id: 'education-test-session-export', name: pathToFileURL(join(repositoryRoot, 'packages/session-query/session-log-export',
          mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href },
        { id: 'education-test-session-controller', name: pathToFileURL(join(repositoryRoot, 'packages/api/session-controller',
          mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href, config: { nativeOpen: false } },
        { id: 'education-identity-test-probe', name: probe },
      ] },
    ], { schema: yamlSchema }))
    const result = await runLoaderSmoke({
      label: `education-identity-${mode}`, cwd: root,
      binScript: join(repositoryRoot, 'apps/cli/src/bin.ts'), configPath: patch,
      tsconfigPath: join(repositoryRoot, 'tsconfig.json'), binArgs: ['--profile', 'headless', '--patch', patch], mode, sourceImport: 'tsx/esm',
      prepare: (cwd) => {
        initProfile(join(cwd, '.dsh/profiles/headless'), [...PROFILE_TEMPLATES.headless!.bundles, '@deepseek-ai/dsh-experimental-education-bundle'])
      },
      env: { EDUCATION_DATABASE_PATH: databasePath, EDUCATION_TEST_MODE: mode,
        DSH_TELEMETRY_DISABLED: 'true', DEEPSEEK_API_KEY: 'synthetic-key-never-used' },
    })
    expect(result.stdout).toContain('EDUCATION_IDENTITY_HTTP_PROBE ')
    expect(result.stdout).toContain('"employees":2,"cookieProtected":true,"originDenied":true,"logoutIsolated":true,"routesRemoved":true')
    expect(result.stdout).toContain('"requestPeers":true,"fetchPeers":true,"revokedPeer":true,"policyWithdrawn":true')
    expect(result.stdout).toContain('"websocketLogoutIsolated":true')
    expect(result.stdout).toContain('EDUCATION_RESOURCE_AUTHORIZATION_PROBE ')
    expect(result.stdout).toContain('EDUCATION_CONTROLLER_PROBE ')
  } finally {
    repository.close()
    if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-'))) throw new Error('fixture outside owned root')
    rmSync(root, { recursive: true, force: true })
  }
})
