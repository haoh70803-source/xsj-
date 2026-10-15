/** Real employee Web Profile; only the nondeterministic model HTTP server is substituted. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { mockServer, type Behavior, type MockServer } from '../../../llm/llm-deepseek/tests/mock-server.ts'
import { replyEvents } from '../../education-workbench/tests/fixture.ts'
import type { RunDTO, RunId } from '@deepseek-ai/dsh-experimental-education-platform/types'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cache = join(repositoryRoot, '.cache/education-employee-tests')
export const PASSWORD = 'synthetic-employee-acceptance-password'
/**
 * Encode explicitly synthetic content in the native protocol.
 * @param body - synthetic model text.
 * @param versions - selected input source IDs.
 * @returns complete response frames.
 */
export function contentReply(body: string, versions: readonly string[] = []): Behavior {
  return nativeReply(JSON.stringify({ body, explanation: '合成模型的修改说明', sourceVersionIds: versions }))
}
/**
 * Encode a synthetic complete native assistant response, including structured reports.
 * @param text - exact synthetic assistant text.
 * @returns native protocol response frames without another application envelope.
 */
export function nativeReply(text: string): Behavior {
  return { kind: 'sse', events: replyEvents(text) }
}
/** One isolated named profile, business database, native session directory, server and child process. */
export class EmployeeFixture {
  origin = ''
  readonly databasePath: string
  readonly harnessHome: string
  private child: ChildProcessWithoutNullStreams | undefined
  private output = ''
  /** @returns captured local synthetic-profile diagnostics for failed composition assertions. */
  startupLog(): string {
    return this.output
  }
  private constructor(
    readonly root: string,
    readonly upstream: MockServer,
    private readonly timeoutMs: number,
  ) {
    this.databasePath = join(root, 'education.sqlite')
    this.harnessHome = join(root, 'harness')
  }
  /**
   * Initialize an isolated deployment with two real employee logins.
   * @param script - nondeterministic model outcomes.
   * @param timeoutMs - generation deadline.
   * @returns an owned fixture before startup.
   */
  static async create(script: Behavior[] = [], timeoutMs = 10_000): Promise<EmployeeFixture> {
    mkdirSync(cache, { recursive: true })
    const root = mkdtempSync(join(cache, 'owned-')),
      upstream = await mockServer(script)
    const fixture = new EmployeeFixture(root, upstream, timeoutMs)
    try {
      const init = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/education-native.mjs'), 'init'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          EDUCATION_NATIVE_HOME: root,
          EDUCATION_NATIVE_PORT: '0',
          EDUCATION_BOOTSTRAP_USERNAME: 'employee-a',
          EDUCATION_BOOTSTRAP_PASSWORD: PASSWORD,
          EDUCATION_CREDENTIALS_PATH: join(root, 'harness/.credentials.yaml'),
          EDUCATION_MODEL_PROVIDER: 'deepseek-official',
        },
      })
      if (init.status !== 0) throw new Error(`Employee profile initialization failed: ${init.stderr}`)
      const provision = spawnSync(
        process.execPath,
        [join(repositoryRoot, 'scripts/education-native.mjs'), 'add-user'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            EDUCATION_NATIVE_HOME: root,
            EDUCATION_BOOTSTRAP_USERNAME: 'employee-b',
            EDUCATION_BOOTSTRAP_PASSWORD: PASSWORD,
          },
        },
      )
      if (provision.status !== 0) throw new Error(`Controlled employee provisioning failed: ${provision.stderr}`)
      await fixture.credential('synthetic-native-key-one')
      return fixture
    } catch (error) {
      await fixture.dispose()
      throw error
    }
  }
  /** @param value - synthetic private credential, retained only in the native provider's managed file. */
  async credential(value: string): Promise<void> {
    if (this.child === undefined) {
      writeFileSync(join(this.harnessHome, '.credentials.yaml'), `EDUCATION_NATIVE_TEST_KEY: ${value}\n`, {
        mode: 0o600,
      })
      return
    }
    const response = await fetch(`${this.origin}/fixture/credentials`, {
      method: 'POST',
      headers: { 'x-fixture-owner': 'synthetic-host-test' },
      body: JSON.stringify({ value }),
    })
    if (response.status !== 200)
      throw new Error(
        `Trusted credential fixture route returned ${response.status}: ${await response.text()}\n${this.output}`,
      )
  }
  /** Start the supported built dsh entry and require the complete composition to activate. */
  async start(extraPatch = ''): Promise<void> {
    const overlay = join(this.root, 'model.patch.yml')
    writeFileSync(
      overlay,
      `
- id: llm-deepseek
  config:
    apiKeyEnv: EDUCATION_NATIVE_TEST_KEY
    baseURL: ${JSON.stringify(this.upstream.url)}
    thinking: disabled
- id: llm-retry
  disabled: true
- id: session-persistence-jsonl
  config:
    root: ${JSON.stringify(join(this.harnessHome, 'sessions'))}
    compression: none
- id: education-controller
  config:
    creationEnabled: true
    researchEnabled: true
    researchTimeoutMs: ${this.timeoutMs}
    credentialRef: EDUCATION_NATIVE_TEST_KEY
    generationTimeoutMs: ${this.timeoutMs}
- insert:
    - id: fixture-credential-host
      name: ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'packages/experimental/education-bundle/tests/fixtures/credential-probe.mjs')).href)}
    - id: fixture-settings-controller
      name: ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'packages/api/settings-controller/lib/index.js')).href)}
${extraPatch}
`,
    )
    const launch = resolveExampleLaunch({
      srcBin: join(repositoryRoot, 'apps/cli/src/bin.ts'),
      mode: 'lib',
      configArgs: ['--profile', 'education', '--patch', overlay, '--no-open'],
    })
    const child = spawn(launch.command, launch.args, {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...launch.env,
        DSH_HOME: this.harnessHome,
        DSH_AGENTS_HOME: join(this.root, 'agents'),
        EDUCATION_DATABASE_PATH: this.databasePath,
        DSH_TELEMETRY_DISABLED: 'true',
        EDUCATION_NATIVE_TEST_KEY: '',
      },
    })
    this.child = child
    this.output = ''
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => {
        fail(new Error(`Employee profile startup timed out:\n${this.output}`))
      }, 30_000)
      const receive = (data: Buffer) => {
        this.output += data.toString()
        if (/\b(?:entry|entries) did not activate\b/.test(this.output)) {
          clearTimeout(timer)
          fail(new Error(`Employee profile was incomplete:\n${this.output}`))
          return
        }
        const ready = /dsh web: (http:\/\/127\.0\.0\.1:\d+)\//.exec(this.output)
        if (ready) {
          this.origin = ready[1]!
          clearTimeout(timer)
          done()
        }
      }
      child.stdout.on('data', receive)
      child.stderr.on('data', receive)
      child.once('error', (error) => {
        clearTimeout(timer)
        fail(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        fail(new Error(`Employee profile exited ${code}:\n${this.output}`))
      })
    })
  }
  /** @param username - synthetic employee. @returns real HttpOnly cookie, kept private to this fixture client. */
  async login(username = 'employee-a'): Promise<string> {
    const result = await fetch(`${this.origin}/education/auth/sign-in`, {
      method: 'POST',
      headers: { Origin: this.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    })
    expect(result.status).toBe(200)
    const cookie = result.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('Employee sign-in did not set a cookie')
    return cookie
  }
  /**
   * Read an actual wire reply without trusting its business value.
   * @param cookie - employee login.
   * @param method - exact namespace/method.
   * @param request - external parameters.
   * @returns HTTP status and structurally checked envelope.
   */
  async raw(
    cookie: string,
    method: string,
    request: object,
  ): Promise<{ response: Response; result?: { ok: boolean; value: unknown; error?: { code: string } } }> {
    const response = await fetch(`${this.origin}/api/${method}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: this.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
    })
    const body = await response.text()
    const payload: unknown = response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(body)
      : null
    const result = record(record(payload)?.result)
    if (typeof result?.ok !== 'boolean') return { response }
    const code = record(result.error)?.code
    return {
      response,
      result: { ok: result.ok, value: result.value, ...(typeof code === 'string' ? { error: { code } } : {}) },
    }
  }
  /**
   * Require successful dispatch before the caller asserts its expected DTO.
   * @param cookie - employee login.
   * @param method - business method.
   * @param request - exact parameters.
   * @returns business value selected by the test's expected DTO type.
   */
  async rpc<T>(cookie: string, method: string, request: object): Promise<T> {
    const value = await this.raw(cookie, `education/${method}`, request)
    expect(value.response.status).toBe(200)
    if (!value.result?.ok)
      throw new Error(`Business RPC ${method} failed with ${value.result?.error?.code ?? 'missing-result'}`)
    return value.result.value as T
  }
  /** @param cookie - private employee. @param runId - original owned run. @returns terminal durable result without resending generation. */
  async waitRun(cookie: string, runId: RunId): Promise<RunDTO> {
    const deadline = Date.now() + this.timeoutMs + 10_000
    while (Date.now() < deadline) {
      const run = await this.rpc<RunDTO>(cookie, 'creationGetRun', { runId })
      if (run.status !== 'pending' && run.status !== 'running') return run
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Owned generation did not settle before the test deadline')
  }
  /** Stop and await this exact owned CLI process. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
      child.kill()
    })
  }
  /** Stop owned resources and remove only this validated fixture directory. */
  async dispose(): Promise<void> {
    await this.stop()
    await this.upstream.close()
    if (dirname(resolve(this.root)) !== resolve(cache) || !this.root.startsWith(join(cache, 'owned-')))
      throw new Error('cleanup outside owned employee fixture')
    rmSync(this.root, { recursive: true, force: true })
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
