/** Invite-only education-content HTTP application composed as an opt-in Harness plugin. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MemberAuth } from './auth.ts'
import { ContentEngine, conflict, findWork } from './engine.ts'
import { analyzeAccounts, WorkbenchStore } from './store.ts'
import type { Member, Work, WorkspaceView } from './types.ts'
import {
  date,
  kind,
  materialId,
  metrics,
  object,
  profile,
  revision,
  sourceIds,
  sourceUrl,
  text,
  workId,
  WorkbenchError,
} from './validation.ts'

/** Cordis plugin identity. */
export const name = 'education-workbench'
/** Required services are provided by the base profile and business HTTP carrier. */
export const inject = ['webServer', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'systemPrompt', 'tools']

/** Explicit deployment inputs; secrets remain on the server. */
export interface Config {
  dataDir: string
  frontendDir: string
  publicOrigin: string
  invitationCode?: string
  provider: string
  model: string
  maxTokens: number
  generationTimeoutMs: number
  maxConcurrentGenerations: number
  maxPromptCharacters: number
  maxRequestBytes: number
  sessionLifetimeMs: number
  loginAttempts: number
  loginWindowMs: number
}

/** Validated plugin deployment configuration. */
export const Config: z<Config> = z.object({
  dataDir: z.string().required(),
  frontendDir: z.string().required(),
  publicOrigin: z.string().required(),
  invitationCode: z.string(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  maxTokens: z.number().min(256).max(16000).default(4096),
  generationTimeoutMs: z.number().min(1000).max(600000).default(180000),
  maxConcurrentGenerations: z.number().min(1).max(32).default(4),
  maxPromptCharacters: z.number().min(1000).max(200000).default(80000),
  maxRequestBytes: z.number().min(1024).max(20000000).default(2000000),
  sessionLifetimeMs: z.number().min(60000).max(604800000).default(43200000),
  loginAttempts: z.number().min(1).max(100).default(10),
  loginWindowMs: z.number().min(1000).max(86400000).default(900000),
})

/**
 * Register private business routes and own their reversible lifetime.
 * @param ctx - injected Harness services.
 * @param config - deployment settings. Register private business routes and own their teardown.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = new URL(config.publicOrigin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== config.publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error('education-workbench: publicOrigin must be one HTTP(S) origin without a path')
  if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
    throw new Error('education-workbench: network deployments require an HTTPS publicOrigin')
  if (origin.port === '0' && origin.protocol === 'http:') origin.port = String(ctx.webServer.port)
  if (config.invitationCode !== undefined && config.invitationCode.length < 16)
    throw new Error('education-workbench: invitationCode must contain at least 16 characters')
  const root = resolve(config.dataDir)
  const frontend = resolve(config.frontendDir)
  await stat(resolve(frontend, 'index.html'))
  const store = new WorkbenchStore(root)
  const auth = new MemberAuth(
    root,
    origin.origin,
    config.invitationCode,
    config.sessionLifetimeMs,
    config.loginAttempts,
    config.loginWindowMs,
  )
  const engine = new ContentEngine(ctx, store, config)

  async function view(member: Member): Promise<WorkspaceView> {
    // A process restart cannot leave a durable record falsely claiming a live generation.
    const current = await store.read(member.id)
    const interrupted = current.works.some(work => work.pendingRequest && !engine.isRunning(member.id, work.id))
    const state = interrupted
      ? await store.update(member.id, (state) => {
        for (const work of state.works) {
          if (work.pendingRequest && !engine.isRunning(member.id, work.id)) {
            work.pendingRequest = null
            work.lastError = '上次生成因服务重启中断，原稿和修改要求已保留。'
            work.revision++
          }
        }
        return state
      })
      : current
    return { ...state, member, runningWorkIds: engine.runningIds(member.id), accounts: analyzeAccounts(state) }
  }

  async function api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    secureHeaders(res)
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.headers.host !== origin.host) throw new WorkbenchError(403, '访问地址与服务器配置不一致。')
      const path = new URL(req.url ?? '/', origin).pathname.slice('/business-api'.length)
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') throw new WorkbenchError(405, '此操作只支持 GET 或 POST。')
      let input: Record<string, unknown> = {}
      if (method === 'POST') {
        if (req.headers.origin !== origin.origin || req.headers['x-workbench-request'] !== '1')
          throw new WorkbenchError(403, '请求来源无效，请从工作台页面操作。')
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
          throw new WorkbenchError(415, '请使用 JSON 提交。')
        input = await readBody(req, config.maxRequestBytes)
      }
      if (method === 'POST' && (path === '/login' || path === '/register')) {
        const result = await auth.login(input, path === '/register', req.socket.remoteAddress ?? 'unknown')
        res.setHeader('Set-Cookie', result.cookie)
        json(res, 200, { member: result.member })
        return
      }
      if (method === 'GET' && path === '/setup') {
        json(res, 200, { registrationOpen: Boolean(config.invitationCode) })
        return
      }
      const member = auth.require(req)
      if (method === 'POST' && path === '/logout') {
        res.setHeader('Set-Cookie', auth.logout(req))
        json(res, 200, { ok: true })
        return
      }
      if (method === 'GET' && path === '/workspace') {
        json(res, 200, await view(member))
        return
      }
      if (method === 'POST' && path === '/profile') {
        const next = profile(input)
        await store.update(member.id, (state) => {
          state.profile = next
        })
        json(res, 200, await view(member))
        return
      }
      if (method === 'POST' && path === '/materials') {
        const title = text(input.title, '资料标题', 200)
        const content = text(input.content, '资料正文', 20000)
        const url = sourceUrl(input.sourceUrl)
        if (input.authorized !== true) throw new WorkbenchError(400, '请确认你有权使用这份资料。')
        await store.update(member.id, (state) => {
          state.materials.unshift({
            id: materialId(randomUUID()),
            title,
            content,
            sourceUrl: url,
            authorized: true,
            revision: 1,
            updatedAt: new Date().toISOString(),
          })
        })
        json(res, 201, await view(member))
        return
      }
      const materialRoute = /^\/materials\/([^/]+)$/.exec(path)
      if (method === 'POST' && materialRoute) {
        const id = materialId(materialRoute[1])
        const expected = revision(input.revision)
        if (typeof input.authorized !== 'boolean') throw new WorkbenchError(400, '资料授权状态无效。')
        const allowed = input.authorized
        await store.update(member.id, (state) => {
          const material = state.materials.find(row => row.id === id)
          if (!material) throw new WorkbenchError(404, '没有找到该资料。')
          if (material.revision !== expected) throw conflict()
          if (state.works.some(work => work.sourceIds.includes(id) && engine.isRunning(member.id, work.id)))
            throw new WorkbenchError(409, '正在使用该资料生成，请先停止生成再调整授权。')
          material.authorized = allowed
          material.revision++
          material.updatedAt = new Date().toISOString()
        })
        json(res, 200, await view(member))
        return
      }
      if (method === 'POST' && path === '/works') {
        const title = text(input.title, '稿件标题', 200)
        const topic = text(input.topic, '选题或原文', 20000)
        const workKind = kind(input.kind)
        const selected = sourceIds(input.sourceIds)
        const work = await store.update(member.id, (state) => {
          for (const id of selected)
            if (!state.materials.some(row => row.id === id && row.authorized))
              throw new WorkbenchError(403, '只能选择本人获准使用的资料。')
          const created: Work = {
            id: workId(randomUUID()),
            title,
            topic,
            kind: workKind,
            sourceIds: selected,
            content: '',
            dialogue: [],
            revision: 1,
            updatedAt: new Date().toISOString(),
            lastError: null,
            pendingRequest: null,
          }
          state.works.unshift(created)
          return created
        })
        json(res, 201, { work, workspace: await view(member) })
        return
      }
      const workRoute = /^\/works\/([^/]+)(?:\/(turn|cancel))?$/.exec(path)
      if (workRoute) {
        const id = workId(workRoute[1])
        findWork(await store.read(member.id), id)
        if (method === 'GET' && !workRoute[2]) {
          json(res, 200, findWork(await store.read(member.id), id))
          return
        }
        if (method === 'POST' && workRoute[2] === 'cancel') {
          engine.cancel(member.id, id)
          json(res, 200, { ok: true })
          return
        }
        if (method === 'POST' && workRoute[2] === 'turn') {
          const work = await engine.generate(member.id, id, input)
          json(res, 200, { work, workspace: await view(member) })
          return
        }
        if (method === 'POST' && !workRoute[2]) {
          const title = text(input.title, '稿件标题', 200)
          const content = text(input.content, '稿件内容', 60000, false)
          const expected = revision(input.revision)
          if (engine.isRunning(member.id, id)) throw new WorkbenchError(409, '正在生成，请等待完成或停止后再编辑。')
          const work = await store.update(member.id, (state) => {
            const row = findWork(state, id)
            if (row.revision !== expected || row.pendingRequest) throw conflict()
            row.title = title
            row.content = content
            row.revision++
            row.updatedAt = new Date().toISOString()
            return row
          })
          json(res, 200, { work, workspace: await view(member) })
          return
        }
      }
      if (method === 'POST' && path === '/metrics') {
        const rows = metrics(input.rows)
        const sourceLabel = text(input.sourceLabel, '数据来源', 200)
        const observedAt = date(input.observedAt)
        if (Date.parse(observedAt) > Date.now() + 60000) throw new WorkbenchError(400, '数据采集时间不能晚于当前时间。')
        await store.update(member.id, (state) => {
          state.metrics = { rows, sourceLabel, observedAt, importedAt: new Date().toISOString() }
        })
        json(res, 200, await view(member))
        return
      }
      throw new WorkbenchError(404, '没有找到该操作。')
    } catch (error) {
      if (!(error instanceof WorkbenchError))
        ctx.logger.warn(`education-workbench: request failed (${error instanceof Error ? error.name : 'unknown'})`)
      const failure =
        error instanceof WorkbenchError
          ? error
          : new WorkbenchError(500, '服务器暂时无法完成操作，请稍后重试或联系管理员。')
      json(res, failure.status, { error: failure.message })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/business-api', handler: api }),
    'education: private API',
  )
  ctx.effect(
    () =>
      ctx.webServer.registerFallback(async (req, res) => {
        secureHeaders(res)
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (req.headers.host !== origin.host) {
          res.writeHead(403)
          res.end()
          return
        }
        const path = new URL(req.url ?? '/', origin).pathname
        if (path !== '/' && path !== '/index.html' && !path.startsWith('/assets/')) {
          res.writeHead(404)
          res.end()
          return
        }
        let decoded: string
        try {
          decoded = decodeURIComponent(path)
        } catch {
          res.writeHead(400)
          res.end()
          return
        }
        const file = resolve(frontend, path === '/' ? 'index.html' : `.${decoded}`)
        if (!file.startsWith(frontend + sep)) {
          res.writeHead(403)
          res.end()
          return
        }
        const mime: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.woff2': 'font/woff2',
          '.svg': 'image/svg+xml',
        }
        try {
          const bytes = await readFile(file)
          res.writeHead(200, {
            'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
          res.writeHead(404)
          res.end()
        }
      }),
    'education: business frontend',
  )
  ctx.effect(
    () => async () => {
      auth.dispose()
      await engine.dispose()
    },
    'education: private runtime',
  )
  console.log(`内容运营工作台：${origin.origin}`)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const length = req.headers['content-length']
  if (length !== undefined && Number(length) > limit)
    throw new WorkbenchError(413, '提交内容过大，请减少资料或数据行数。')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const received of req) {
    const chunk: unknown = received
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw new WorkbenchError(400, '请求内容格式不正确。')
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += buffer.length
    if (bytes > limit) throw new WorkbenchError(413, '提交内容过大，请减少资料或数据行数。')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new WorkbenchError(400, 'JSON 格式不正确。')
  }
  return object(value)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
function secureHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
}
