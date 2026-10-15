/** Built-profile fixture: the real dsh launcher and native model adapter, with only the HTTP provider mocked. */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { mockServer } from '../../../llm/llm-deepseek/tests/mock-server.ts'
import type { Behavior, MockServer } from '../../../llm/llm-deepseek/tests/mock-server.ts'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const cache = join(repository, '.cache')
export const INVITATION = 'education-regression-invitation-only'
export const PASSWORD = 'education-regression-password-only'

/** @param reply - synthetic test content. @returns native Messages SSE frames. */
export function replyEvents(reply: string): string[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'education-test-response',
        model: 'deepseek-v4-flash',
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ].map(event => JSON.stringify(event))
}

/** Owns one isolated built Harness process and its mocked upstream. */
export class WorkbenchFixture {
  origin = ''
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly patch: string
  private output = ''

  private constructor(
    readonly root: string,
    readonly upstream: MockServer,
    patch: string,
  ) {
    this.patch = patch
    this.env = {
      ...process.env,
      DSH_HOME: join(root, 'harness'),
      DSH_AGENTS_HOME: join(root, 'agent-config'),
      EDUCATION_TEST_KEY: 'education-test-mock-api-key',
      EDUCATION_INVITATION_CODE: INVITATION,
    }
  }

  /** @param script - mocked provider outcomes. @returns an isolated fixture before launch. */
  static async create(script: Behavior[]): Promise<WorkbenchFixture> {
    await mkdir(cache, { recursive: true })
    const root = await mkdtemp(join(cache, 'education-regression-'))
    const upstream = await mockServer(script)
    const patch = join(root, 'test.patch.yml')
    await writeFile(
      patch,
      dump([
        { id: 'education-webserver', config: { host: '127.0.0.1', port: 0 } },
        { id: 'session-persistence-jsonl', config: { root: join(root, 'harness/sessions'), compression: 'none' } },
        {
          id: 'llm-deepseek',
          config: { baseURL: upstream.url, apiKeyEnv: 'EDUCATION_TEST_KEY', thinking: 'disabled' },
        },
        {
          id: 'education-workbench',
          config: {
            dataDir: join(root, 'records'),
            frontendDir: join(repository, 'apps/web/education/dist'),
            publicOrigin: 'http://127.0.0.1:0',
            invitationCode: INVITATION,
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            generationTimeoutMs: 10000,
          },
        },
      ]),
    )
    return new WorkbenchFixture(root, upstream, patch)
  }

  /** Boot the supported headless profile with its one-shot driver replaced by the business plugin. */
  async start(): Promise<void> {
    if (this.child) throw new Error('fixture already running')
    this.output = ''
    const launch = resolveExampleLaunch({
      srcBin: join(repository, 'apps/cli/src/bin.ts'),
      mode: 'lib',
      configArgs: [
        '--profile',
        'headless',
        '--patch',
        join(repository, 'packages/experimental/education-workbench/workbench.patch.yml'),
        '--patch',
        this.patch,
      ],
    })
    const child = spawn(launch.command, launch.args, {
      cwd: repository,
      env: { ...this.env, ...launch.env },
      windowsHide: true,
      stdio: 'pipe',
    })
    this.child = child
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`business profile did not start:\n${this.output}`))
      }, 20000)
      const receive = (data: Buffer) => {
        this.output += data.toString()
        const found = /内容运营工作台：\s*(http:\/\/127\.0\.0\.1:\d+)/.exec(this.output)
        if (found) {
          this.origin = found[1]!
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout.on('data', receive)
      child.stderr.on('data', receive)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`business profile exited (${code ?? signal}):\n${this.output}`))
      })
    })
  }

  /** Stop and await the owned child. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
      child.kill()
    })
  }

  /** Stop the process and upstream; remove only the verified fixture-owned directory. */
  async dispose(): Promise<void> {
    await this.stop()
    await this.upstream.close()
    if (dirname(resolve(this.root)) !== resolve(cache) || !this.root.startsWith(join(cache, 'education-regression-')))
      throw new Error('fixture cleanup outside owned cache')
    await rm(this.root, { recursive: true, force: true })
  }

  /** @returns an independent authenticated browser client. */
  member(): TestMember {
    return new TestMember(this)
  }
}

/** Cookie-scoped test client; no shared authorization between members. */
export class TestMember {
  cookie = ''
  /** @param fixture - isolated business process. */
  constructor(private readonly fixture: WorkbenchFixture) {}

  /** @param path - API pathname. @param input - optional JSON POST. @returns the actual HTTP response. */
  async request(path: string, input?: object): Promise<Response> {
    const response = await fetch(`${this.fixture.origin}/business-api${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: this.cookie,
        Origin: this.fixture.origin,
        'Content-Type': 'application/json',
        'X-Workbench-Request': '1',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    const cookie = response.headers.get('set-cookie')
    if (cookie) this.cookie = cookie.split(';')[0]!
    return response
  }

  /** @param path - API pathname. @param input - optional mutation. @returns a successful, typed test response. */
  async json<T>(path: string, input?: object): Promise<T> {
    const response = await this.request(path, input)
    const result: unknown = await response.json()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`)
    return result as T
  }
}
