/** Employee resource authorization and controlled ownership of validation Agents. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionAccess } from '@deepseek-ai/dsh-client-connection'
import { EducationError, type EducationRepository } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ActorContext, BindSessionInput, SessionBindingDTO } from '@deepseek-ai/dsh-experimental-education-platform/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned private resource policy; never exposed as a Remote namespace. */
    educationAuthorization: EducationAuthorization
  }
  interface Events {
    /**
     * Close existing owner connections after a native association is durably invalidated.
     * @param actor - trusted owner whose connections must reauthorize.
     * @mode parallel
     */
    'education-authorization/revoked'(actor: ActorContext): void
    /** Close existing scopes so removed feature grants cannot retain idle subscriptions. @mode parallel */
    'education-authorization/policy-changed'(): void
  }
}

/** Feature-owned grant; both callbacks run only on the Host and must validate their external operation fields. */
export interface EducationAccessRule {
  readonly matches: (access: ConnectionAccess) => boolean
  readonly allows: (actor: ActorContext, access: ConnectionAccess) => boolean
}

interface OwnedAgent {
  readonly handle: AgentHandle
  readonly release: () => Promise<void>
}

/** Denies unknown operations and authorizes Session reads only through an active same-owner binding. */
export class EducationAuthorization extends Service {
  private readonly agents = new Map<SessionId, OwnedAgent>()
  private readonly rules = new Set<EducationAccessRule>()
  private readonly denied: (actor: ActorContext, reason: string, kind: ConnectionAccess['kind']) => void

  /**
   * Provide private resource decisions; existing repository transactions remain authoritative for writes.
   * @param ctx - owning identity adapter context.
   * @param repository - durable ownership and current login checks.
   */
  constructor(ctx: Context, private readonly repository: EducationRepository) {
    super(ctx, 'educationAuthorization')
    const logger = ctx.logger
    this.denied = (actor, reason, kind) => {
      logger.warn('Education resource access denied', {
        organizationId: actor.organizationId, userId: actor.userId, reason, kind,
      })
    }
  }

  /**
   * Register an explicit feature-owned grant; absence or unloading leaves its operations denied.
   * @param rule - exact operation matching and actor/resource checks, with no client-supplied Actor.
   * @returns disposer removing this caller's contribution.
   */
  register(rule: EducationAccessRule): () => Promise<void> {
    return this.ctx.effect(() => {
      this.rules.add(rule)
      return () => {
        this.rules.delete(rule)
        this.ctx.emit('education-authorization/policy-changed')
      }
    }, 'education-authorization: feature access rule')
  }

  /**
   * Evaluate current identity and resource ownership before dispatch or delivery.
   * @param actor - trusted identity resolved from a request Peer.
   * @param access - decoded operation; unknown native and global operations are denied.
   * @returns whether this operation is currently allowed; storage faults propagate and stop dispatch.
   */
  allows(actor: ActorContext, access: ConnectionAccess): boolean {
    this.repository.readSelf(actor)
    try {
      if (this.nativeAccess(actor, access)) return true
      for (const rule of this.rules) {
        if (rule.matches(access)) {
          const granted = rule.allows(actor, access)
          if (!granted) this.denied(actor, 'feature-resource-unavailable', access.kind)
          return granted
        }
      }
    } catch (error) {
      if (!(error instanceof EducationError) || error.code !== 'resource-unavailable') throw error
      this.denied(actor, 'binding-unavailable', access.kind)
      return false
    }
    this.denied(actor, 'operation-not-enabled', access.kind)
    return false
  }

  /**
   * Adopt a controlled live Agent and bind it to same-owner business resources.
   * @param actor - trusted creator, revalidated by the repository at commit.
   * @param input - explicit same-owner resources and matching native identity.
   * @param handle - newly created controlled Agent; ownership transfers here, including cleanup on failure.
   * @returns durable association; native creation and business commit are separate operations.
   */
  async bindAgent(actor: ActorContext, input: BindSessionInput, handle: AgentHandle): Promise<SessionBindingDTO> {
    if (this.agents.has(handle.agent.id)) throw new EducationError('resource-unavailable', 'resource unavailable')
    let release: (() => Promise<void>) | undefined
    try {
      release = this.ctx.effect(() => async () => {
        if (this.agents.get(handle.agent.id)?.handle === handle) this.agents.delete(handle.agent.id)
        await handle.dispose()
      }, 'education-authorization: controlled Agent')
      if (handle.agent.id !== input.harnessSessionId || handle.agent.session.id !== handle.agent.id
        || this.ctx.get('agents')?.get(handle.agent.id) !== handle.agent) throw unavailable()
      const binding = this.repository.bindSession(actor, input).binding
      this.agents.set(handle.agent.id, { handle, release })
      return binding
    } catch (error) {
      this.denied(actor, 'binding-failed', 'remote')
      try { await (release === undefined ? handle.dispose() : release()) }
      catch (cleanupError) {
        throw new EducationError('identity-unavailable', 'native binding failed and Agent cleanup failed; review the controlled runtime',
          { cause: new AggregateError([error, cleanupError]) })
      }
      throw error
    }
  }

  /**
   * Invalidate an owned association, close owner connections and stop its adopted Agent.
   * @param actor - trusted current resource owner.
   * @param sessionId - association to invalidate; foreign and missing values reject uniformly.
   * @returns after durable invalidation and runtime cleanup; failure never restores the association.
   */
  async invalidateSession(actor: ActorContext, sessionId: SessionId): Promise<void> {
    this.repository.invalidateSessionBinding(actor, sessionId)
    this.ctx.emit('education-authorization/revoked', actor)
    await this.agents.get(sessionId)?.release()
  }

  /**
   * Release a runtime-owned live handle while retaining its authorized cold Session history.
   * @param sessionId - exact Session previously adopted by this registry.
   */
  async releaseAgent(sessionId: SessionId): Promise<void> { await this.agents.get(sessionId)?.release() }

  private nativeAccess(actor: ActorContext, access: ConnectionAccess): boolean {
    if (access.kind === 'events') return true
    if (access.kind === 'rpc' && access.channel === '/api') {
      if (access.endpoint === '$events/result') return true
      const [namespace, method, extra] = access.endpoint.split('/')
      if (namespace === undefined || method === undefined || extra !== undefined) return false
      const args = record(access.payload)?.args
      const named = record(args)
      return named !== undefined && this.nativeAccess(actor, { kind: 'remote', namespace, method, args: named })
    }
    if (access.kind === 'remote' && access.namespace === 'session'
      && ['page', 'follow', 'projections'].includes(access.method)) {
      const request = record(access.args.request)
      const address = record(request?.address)
      const sessionId = nativeId(access.method === 'projections' ? request?.sessionId
        : address?.kind === 'session' ? address.sessionId : undefined)
      if (sessionId === undefined) throw unavailable()
      this.repository.getSessionBinding(actor, sessionId)
      return true
    }
    if (access.kind === 'event' && access.agentId !== undefined) {
      const sessionId = nativeId(access.agentId)
      const entry = sessionId === undefined ? undefined : this.agents.get(sessionId)
      if (entry === undefined || access.subject !== entry.handle.agent
        || this.ctx.get('agents')?.get(entry.handle.agent.id) !== entry.handle.agent
        || entry.handle.agent.session.id !== sessionId) throw unavailable()
      this.repository.getSessionBinding(actor, entry.handle.agent.session.id)
      return true
    }
    return false
  }
}

function nativeId(value: unknown): SessionId | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200 ? brandString<SessionId>(value) : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

function unavailable(): EducationError {
  return new EducationError('resource-unavailable', 'resource unavailable')
}
