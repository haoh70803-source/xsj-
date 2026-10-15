/** Invite-only member authentication; passwords use salted scrypt and sessions use hashed random tokens. */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Member, MemberId } from './types.ts'
import { readJson } from './store.ts'
import { object, text, uuid, WorkbenchError } from './validation.ts'

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}
interface Account extends Member {
  salt: string
  passwordHash: string
}
interface Session {
  member: Member
  expiresAt: number
}

/** Process-owned sessions are invalidated on restart; account records remain durable. */
export class MemberAuth {
  private readonly sessions = new Map<string, Session>()
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()
  private readonly filename: string
  /** Namespace for this standalone prototype's HttpOnly login cookie. */
  readonly cookieName: string

  /**
   * @param root - private deployment data.
   * @param origin - configured browser origin.
   * @param invitation - operator-owned signup code.
   * @param lifetimeMs - session lifetime.
   * @param loginAttempts - attempt limit per window.
   * @param loginWindowMs - throttle window.
   */
  constructor(
    private readonly root: string,
    readonly origin: string,
    private readonly invitation: string | undefined,
    private readonly lifetimeMs: number,
    private readonly loginAttempts: number,
    private readonly loginWindowMs: number,
  ) {
    this.filename = join(root, 'accounts.json')
    this.cookieName = origin.startsWith('https:') ? '__Host-education-session' : 'education-session'
  }

  /**
   * Authenticate the account and issue an independently scoped login cookie.
   * @param input - external login or invited signup fields.
   * @param register - create an account only with a valid invitation.
   * @param address - direct socket peer.
   * @returns member and a one-time raw cookie value.
   */
  async login(input: unknown, register: boolean, address: string): Promise<{ member: Member; cookie: string }> {
    const value = object(input)
    const username = text(value.username, '用户名', 32).normalize('NFKC').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username))
      throw new WorkbenchError(400, '用户名需要是 3 至 32 位英文字母、数字、点、横线或下划线。')
    const password = text(value.password, '密码', 200)
    this.throttle(address)
    this.throttle(`member:${username}`)
    let account: Account | undefined
    if (register) {
      if (!this.invitation || !sameSecret(text(value.invitationCode, '邀请码', 200), this.invitation))
        throw new WorkbenchError(403, '邀请码无效，或注册尚未开放。')
      if (password.length < 12) throw new WorkbenchError(400, '密码至少需要 12 个字符。')
      const salt = randomBytes(16).toString('hex')
      const passwordHash = (await derive(password, salt)).toString('hex')
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      account = await withFileLock(this.filename, async () => {
        const accounts = await this.accounts()
        if (accounts.some(row => row.username === username)) throw new WorkbenchError(409, '该用户名已被使用。')
        const created: Account = { id: brandString<MemberId>(randomUUID()), username, salt, passwordHash }
        accounts.push(created)
        await writeFileAtomic(this.filename, JSON.stringify({ version: 1, accounts }), { mode: 0o600, dirMode: 0o700 })
        return created
      })
    } else {
      account = (await this.accounts()).find(row => row.username === username)
      const hash = (await derive(password, account?.salt ?? 'education-workbench-dummy-salt')).toString('hex')
      if (!account || !sameSecret(hash, account.passwordHash)) throw new WorkbenchError(401, '用户名或密码不正确。')
    }
    const member: Member = { id: account.id, username: account.username }
    this.prune()
    const token = randomBytes(32).toString('hex')
    this.sessions.set(digest(token), { member, expiresAt: Date.now() + this.lifetimeMs })
    this.attempts.delete(`member:${username}`)
    return { member, cookie: this.cookie(token, Math.floor(this.lifetimeMs / 1000)) }
  }

  /**
   * Require an authenticated account for the incoming request.
   * @param request - current browser request.
   * @returns server-authenticated member, never an input owner field.
   */
  require(request: IncomingMessage): Member {
    const token = this.token(request)
    const session = this.sessions.get(digest(token))
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(digest(token))
      throw new WorkbenchError(401, '请先登录，或重新登录已过期的账号。')
    }
    return session.member
  }

  /**
   * Invalidate the selected login without affecting other employees.
   * @param request - browser request.
   * @returns the cookie that clears this session.
   */
  logout(request: IncomingMessage): string {
    this.sessions.delete(digest(this.token(request)))
    return this.cookie('', 0)
  }

  /** Destroy all live authentication state on plugin unload. */
  dispose(): void {
    this.sessions.clear()
    this.attempts.clear()
  }

  private token(request: IncomingMessage): string {
    const value = request.headers.cookie
      ?.split(';')
      .map(item => item.trim())
      .find(item => item.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1)
    return value && /^[a-f0-9]{64}$/.test(value) ? value : ''
  }

  private cookie(token: string, age: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.origin.startsWith('https:') ? '; Secure' : ''}`
  }

  private throttle(key: string): void {
    const now = Date.now()
    this.prune()
    let entry = this.attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.loginWindowMs }
      this.attempts.set(key, entry)
    }
    entry.count++
    if (entry.count > this.loginAttempts) throw new WorkbenchError(429, '尝试次数过多，请稍后再试。')
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, row] of this.sessions) if (row.expiresAt <= now) this.sessions.delete(key)
    for (const [key, row] of this.attempts) if (row.resetAt <= now) this.attempts.delete(key)
  }

  private async accounts(): Promise<Account[]> {
    const input = await readJson(this.filename)
    if (input === null) return []
    const value = object(input)
    if (value.version !== 1 || !Array.isArray(value.accounts))
      throw new Error('education-workbench: malformed accounts file')
    return value.accounts.map((row) => {
      const item = object(row)
      if (
        typeof item.salt !== 'string' ||
        !/^[a-f0-9]{32}$/.test(item.salt) ||
        typeof item.passwordHash !== 'string' ||
        !/^[a-f0-9]{128}$/.test(item.passwordHash)
      )
        throw new Error('education-workbench: malformed password record')
      return {
        id: brandString<MemberId>(uuid(item.id)),
        username: text(item.username, '用户名', 32),
        salt: item.salt,
        passwordHash: item.passwordHash,
      }
    })
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'))
}
