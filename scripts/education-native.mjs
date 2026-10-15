/** Configure an isolated employee deployment, then launch only through its named dsh profile. */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { initProfile } from '../packages/boot/app-boot/lib/index.js'
import { SqliteEducationRepository } from '../packages/experimental/education-storage-sqlite/lib/index.js'
import { resolveConfig } from '../packages/experimental/education-storage-sqlite/lib/index.js'
import { createPasswordCredential } from '../packages/experimental/education-identity/lib/index.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
process.chdir(repositoryRoot)
const root = resolve(process.env.EDUCATION_NATIVE_HOME ?? '.cache/education-native')
const configuration = join(root, 'deployment.json')
mkdirSync(root, { recursive: true, mode: 0o700 })
if (process.argv[2] === 'add-user' && !existsSync(configuration)) throw new Error('Initialize the employee deployment before provisioning another user.')
if (!existsSync(configuration)) {
  const databasePath = join(root, 'education.sqlite')
  if (existsSync(databasePath)) throw new Error('An employee database exists without deployment.json; recover its configuration before initializing another organization.')
  const repository = await SqliteEducationRepository.open(resolveConfig({ path: databasePath }))
  try {
    const organizationId = repository.provisionOrganization('鑫世界工作台')
    const username = process.env.EDUCATION_BOOTSTRAP_USERNAME ?? 'owner'
    const password = process.env.EDUCATION_BOOTSTRAP_PASSWORD ?? randomBytes(18).toString('base64url')
    repository.provisionUser({ organizationId, usernameNormalized: username, ...await createPasswordCredential(password) })
    writeFileSync(join(root, 'first-login.txt'), `用户名 / Username: ${username}\n密码 / Password: ${password}\n`, { flag: 'wx', mode: 0o600 })
    writeFileSync(configuration, JSON.stringify({ organizationId, databasePath, port: 3191 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } finally { repository.close() }
}
const deployment = JSON.parse(readFileSync(configuration, 'utf8'))
if (typeof deployment.organizationId !== 'string' || typeof deployment.databasePath !== 'string' || !Number.isInteger(deployment.port)) throw new Error('Invalid employee deployment configuration')
if (process.argv[2] === 'add-user') {
  const usernameNormalized = process.env.EDUCATION_BOOTSTRAP_USERNAME
  if (!usernameNormalized) throw new Error('Set EDUCATION_BOOTSTRAP_USERNAME to the new lowercase employee username.')
  const password = process.env.EDUCATION_BOOTSTRAP_PASSWORD ?? randomBytes(18).toString('base64url')
  const repository = await SqliteEducationRepository.open(resolveConfig({ path: deployment.databasePath }))
  try {
    const user = repository.provisionUser({ organizationId: deployment.organizationId, usernameNormalized, ...await createPasswordCredential(password) })
    const accountDirectory = join(root, 'accounts'); mkdirSync(accountDirectory, { recursive: true, mode: 0o700 })
    const accountFile = join(accountDirectory, `${user.username}.txt`)
    writeFileSync(accountFile, `用户名 / Username: ${user.username}\n密码 / Password: ${password}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`新员工登录信息：${accountFile}`)
  } finally { repository.close() }
  process.exit(0)
}
const home = join(root, 'harness'), profile = join(home, 'profiles/education')
initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-education-bundle'])
const packageLink = join(profile, 'node_modules/@deepseek-ai/dsh-experimental-education-bundle')
mkdirSync(dirname(packageLink), { recursive: true })
if (!existsSync(packageLink)) symlinkSync(join(repositoryRoot, 'packages/experimental/education-bundle'), packageLink, 'junction')

const yamlString = value => JSON.stringify(value)
// The browser keeps native rendering, layout, locale and transport; no employee navigation exposes operator pages.
const retained = new Set(['web-startup', 'webserver', 'web-runtime', 'modules', 'connection', 'api-remotes', 'ui-theme', 'locale', 'shortcuts', 'ui-renderer', 'ui-layout', 'ui-session', 'ui-settings', 'session-controller', 'file-upload', 'workspace'])
const { load, DEFAULT_SCHEMA, Type } = await import('js-yaml')
const userCredentials = join(homedir(), '.dsh/.credentials.yaml')
const credentialsPath = resolve(process.env.EDUCATION_CREDENTIALS_PATH ?? deployment.credentialsPath ?? (existsSync(userCredentials) ? userCredentials : join(home, '.credentials.yaml')))
const credentialMetadata = existsSync(credentialsPath) ? load(readFileSync(credentialsPath, 'utf8')) : undefined
const provider = process.env.EDUCATION_MODEL_PROVIDER ?? deployment.provider ?? (credentialMetadata?.records?.['deepseek-account-platform/default']?.kind === 'grant' ? 'deepseek-account' : 'deepseek-official')
const model = process.env.EDUCATION_MODEL ?? deployment.model ?? 'deepseek-flash'
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
const webRows = load(readFileSync(join(repositoryRoot, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8'), { schema })
const disabled = webRows.flatMap(row => row.insert ?? []).filter(row => !retained.has(row.id)).map(row => `- id: ${row.id}\n  disabled: true`).join('\n')
const employee = readFileSync(join(repositoryRoot, 'packages/experimental/education-bundle/employee.patch.yml'), 'utf8')
const port = Number(process.env.EDUCATION_NATIVE_PORT ?? deployment.port)
if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw new Error('Employee port must be zero or between 1024 and 65535')
const credentialRef = process.env.EDUCATION_MODEL_CREDENTIAL_REF ?? 'DEEPSEEK_API_KEY'
const patch = `${employee}\n${disabled}\n
- id: education-storage-sqlite
  config:
    path: ${yamlString(deployment.databasePath)}
- id: education-identity
  inject: [webServer]
  config:
    organizationId: ${yamlString(deployment.organizationId)}
    publicOrigin: !!js "'http://127.0.0.1:' + ctx.webServer.port"
    adaptConnection: true
    loginShell: true
- id: webserver
  config:
    host: 127.0.0.1
    port: ${port}
- id: web-runtime
  inject: [webStartup, webServer, educationPlatform, educationPeers, educationController, educationShellReady]
  config:
    openBrowser: false
    printUrl: true
    publicUrl: !!js "'http://127.0.0.1:' + ctx.webServer.port"
    surfaceContext: false
- id: education-controller
  disabled: false
  config:
    creationEnabled: true
    researchEnabled: true
    credentialRef: ${yamlString(credentialRef)}
    provider: ${yamlString(provider)}
    model: ${yamlString(model)}
    analytics: ${JSON.stringify(deployment.analytics ?? {})}
- id: credentials
  config:
    path: ${yamlString(credentialsPath)}
- id: llm-deepseek
  config:
    apiKeyEnv: ${yamlString(credentialRef)}
    thinking: disabled
- id: llm-deepseek-account
  config:
    thinking: disabled
`
writeFileSync(join(profile, 'cordis.patch.yml'), patch)
console.log(`员工工作台配置：${configuration}`)
console.log(`首次登录信息：${join(root, 'first-login.txt')}`)
if (process.argv[2] !== 'init') {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'apps/cli/lib/bin.js'), '--profile', 'education', ...process.argv.slice(2), '--no-open'], {
    cwd: repositoryRoot, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), EDUCATION_DATABASE_PATH: deployment.databasePath },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
