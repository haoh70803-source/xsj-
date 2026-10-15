/** Bounded validation at HTTP and durable JSON inputs. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentMetric, MaterialId, Profile, WorkId, WorkKind, WorkspaceState } from './types.ts'

/** A failure safe to show to a workbench user. */
export class WorkbenchError extends Error {
  /** @param status - HTTP response code. @param message - public explanation. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Validate an external object before reading its business fields.
 * @param value - external JSON.
 * @returns a JSON object or a validation failure.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new WorkbenchError(400, '请提交有效的 JSON 对象。')
  return value as Record<string, unknown>
}

/**
 * Return validated text.
 * @param value - input string.
 * @param label - field label.
 * @param max - character bound.
 * @param required - reject empty strings.
 * @returns validated text.
 */
export function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new WorkbenchError(400, `${label}不能为空，且不能超过 ${max} 个字符。`)
  return value
}

/**
 * Validate a nonnegative optimistic revision.
 * @param value - external value.
 * @returns a positive optimistic revision.
 */
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new WorkbenchError(400, '版本号无效，请重新打开稿件。')
  return value
}

/**
 * Validate a canonical UUID used as a business identity.
 * @param value - external identity.
 * @returns a validated UUID.
 */
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new WorkbenchError(400, '记录标识无效。')
  return value
}

/**
 * Validate a private material identifier.
 * @param value - material identity.
 * @returns a validated opaque identity.
 */
export function materialId(value: unknown): MaterialId {
  return brandString<MaterialId>(uuid(value))
}
/**
 * Validate a private work identifier.
 * @param value - work identity.
 * @returns a validated opaque identity.
 */
export function workId(value: unknown): WorkId {
  return brandString<WorkId>(uuid(value))
}

/**
 * Validate a source URL without fetching its content.
 * @param value - an external URL.
 * @returns an empty or HTTP(S) source URL.
 */
export function sourceUrl(value: unknown): string {
  const input = text(value, '来源链接', 2000, false).trim()
  if (!input) return ''
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WorkbenchError(400, '来源链接需要是完整的 http 或 https 地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new WorkbenchError(400, '来源链接只支持不包含登录信息的 http 或 https 地址。')
  return url.href
}

/**
 * Validate the complete confirmed creator profile.
 * @param value - external personal profile.
 * @returns bounded profile fields.
 */
export function profile(value: unknown): Profile {
  const input = object(value)
  return {
    displayName: text(input.displayName, '姓名', 80).trim(),
    role: text(input.role, '岗位', 100).trim(),
    institution: text(input.institution, '机构', 200, false),
    audience: text(input.audience, '目标读者', 1000),
    voice: text(input.voice, '表达习惯', 3000),
    facts: text(input.facts, '真实经历', 6000, false),
    forbiddenClaims: text(input.forbiddenClaims, '表达禁区', 3000, false),
  }
}

/**
 * Validate the content scenario.
 * @param value - external content scenario.
 * @returns a supported work kind.
 */
export function kind(value: unknown): WorkKind {
  if (value !== 'script' && value !== 'moments' && value !== 'analysis') throw new WorkbenchError(400, '创作类型无效。')
  return value
}

/**
 * Validate selected private source identities.
 * @param value - selected knowledge identities.
 * @returns unique validated identities.
 */
export function sourceIds(value: unknown): MaterialId[] {
  if (!Array.isArray(value) || value.length > 8) throw new WorkbenchError(400, '每次最多选择 8 份资料。')
  return [...new Set(value.map(materialId))]
}

/**
 * Validate imported metrics without inventing observations.
 * @param value - imported actual platform metrics.
 * @returns validated rows.
 */
export function metrics(value: unknown): ContentMetric[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5000)
    throw new WorkbenchError(400, '请导入 1 至 5000 条实际内容数据。')
  return value.map((row) => {
    const input = object(row)
    if (input.platform !== 'douyin' && input.platform !== 'xiaohongshu')
      throw new WorkbenchError(400, '平台需要是 douyin 或 xiaohongshu。')
    if (typeof input.likes !== 'number' || !Number.isSafeInteger(input.likes) || input.likes < 0)
      throw new WorkbenchError(400, '点赞数需要是非负整数。')
    if (!Array.isArray(input.keywords) || input.keywords.length > 20)
      throw new WorkbenchError(400, '关键词需要是数组，最多 20 个。')
    return {
      platform: input.platform,
      account: text(input.account, '账号名称', 200).trim(),
      title: text(input.title, '作品标题', 1000),
      likes: input.likes,
      keywords: input.keywords.map(word => text(word, '关键词', 80)),
      url: sourceUrl(input.url),
    }
  })
}

/**
 * Validate the persisted private workspace before using it.
 * @param value - persisted owner-private workspace.
 * @returns validated state without silently repairing corruption.
 */
export function workspace(value: unknown): WorkspaceState {
  const input = object(value)
  if (input.version !== 1 || !Array.isArray(input.materials) || !Array.isArray(input.works))
    throw new Error('education-workbench: unsupported or malformed workspace file')
  const state: WorkspaceState = {
    version: 1,
    profile: input.profile === null ? null : profile(input.profile),
    materials: input.materials.map((row) => {
      const item = object(row)
      if (typeof item.authorized !== 'boolean') throw new Error('education-workbench: invalid material authorization')
      return {
        id: materialId(item.id),
        title: text(item.title, '资料标题', 200),
        content: text(item.content, '资料正文', 20000),
        sourceUrl: sourceUrl(item.sourceUrl),
        authorized: item.authorized,
        revision: revision(item.revision),
        updatedAt: date(item.updatedAt),
      }
    }),
    works: input.works.map((row) => {
      const item = object(row)
      if (
        !Array.isArray(item.dialogue) ||
        (item.pendingRequest !== null && typeof item.pendingRequest !== 'string') ||
        (item.lastError !== null && typeof item.lastError !== 'string')
      )
        throw new Error('education-workbench: malformed work dialogue')
      return {
        id: workId(item.id),
        title: text(item.title, '稿件标题', 200),
        kind: kind(item.kind),
        topic: text(item.topic, '创作要求', 20000),
        sourceIds: sourceIds(item.sourceIds),
        content: text(item.content, '稿件内容', 60000, false),
        revision: revision(item.revision),
        updatedAt: date(item.updatedAt),
        lastError: item.lastError,
        pendingRequest: item.pendingRequest,
        dialogue: item.dialogue.map((row) => {
          const line = object(row)
          if (line.role !== 'user' && line.role !== 'assistant')
            throw new Error('education-workbench: malformed dialogue role')
          return {
            role: line.role,
            text: text(line.text, '对话内容', 100000),
            createdAt: date(line.createdAt),
            requestId: uuid(line.requestId),
          }
        }),
      }
    }),
    metrics: null,
  }
  if (input.metrics !== null) {
    const dataset = object(input.metrics)
    state.metrics = {
      rows: metrics(dataset.rows),
      sourceLabel: text(dataset.sourceLabel, '数据来源', 200),
      observedAt: date(dataset.observedAt),
      importedAt: date(dataset.importedAt),
    }
  }
  return state
}

/**
 * Validate a canonical date used by content metrics.
 * @param value - external timestamp.
 * @returns an ISO timestamp.
 */
export function date(value: unknown): string {
  const input = text(value, '数据时间', 80)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input) || !Number.isFinite(Date.parse(input)))
    throw new WorkbenchError(400, '请提供有效的数据采集时间。')
  return new Date(input).toISOString()
}
