/** Atomic private records and median analysis; accounts never choose another owner's path. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AccountAnalysis, MemberId, WorkspaceState } from './types.ts'
import { workspace } from './validation.ts'

/**
 * Return an empty workspace with no invented business data.
 * @returns an empty workspace with no invented business data.
 */
export function emptyWorkspace(): WorkspaceState {
  return { version: 1, profile: null, materials: [], works: [], metrics: null }
}

/**
 * Return decoded data, or null only for an absent file.
 * @param filename - owned JSON path.
 * @returns decoded data, or null only for an absent file.
 */
export async function readJson(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Owner-scoped storage. Every transaction rereads under a cross-process lock. */
export class WorkbenchStore {
  /** @param root - private deployment data directory. */
  constructor(readonly root: string) {}

  /**
   * Read the private owner record without changing durable contents.
   * @param owner - identity supplied by server authentication.
   * @returns the current private workspace.
   */
  async read(owner: MemberId): Promise<WorkspaceState> {
    const value = await readJson(this.path(owner))
    return value === null ? emptyWorkspace() : workspace(value)
  }

  /**
   * Commit the owner record mutation through the serialized writer.
   * @param owner - authenticated member.
   * @param change - mutation to atomically commit.
   * @returns the committed mutation result.
   */
  async update<T>(owner: MemberId, change: (state: WorkspaceState) => T): Promise<T> {
    const filename = this.path(owner)
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    return withFileLock(filename, async () => {
      const state = await this.read(owner)
      const result = change(state)
      await writeFileAtomic(filename, JSON.stringify(workspace(state)), { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }

  private path(owner: MemberId): string {
    return join(this.root, 'members', owner, 'workspace.json')
  }
}

/**
 * Return medians computed per platform and account before keyword filtering.
 * @param state - one member's actual imported rows.
 * @returns medians computed per platform and account before keyword filtering.
 */
export function analyzeAccounts(state: WorkspaceState): AccountAnalysis[] {
  const groups = new Map<string, AccountAnalysis>()
  for (const row of state.metrics?.rows ?? []) {
    const key = JSON.stringify([row.platform, row.account])
    let group = groups.get(key)
    if (!group) {
      group = { platform: row.platform, account: row.account, count: 0, medianLikes: 0, aboveMedian: [] }
      groups.set(key, group)
    }
    group.aboveMedian.push(row)
  }
  return [...groups.values()].map((group) => {
    const rows = group.aboveMedian
    const likes = rows.map(row => row.likes).sort((a, b) => a - b)
    const middle = Math.floor(likes.length / 2)
    const center = likes[middle]
    if (center === undefined) throw new Error('account analysis group has no metric rows')
    const lower = likes[middle - 1]
    if (likes.length % 2 === 0 && lower === undefined) throw new Error('account analysis median is incomplete')
    const medianLikes = lower === undefined || likes.length % 2 ? center : lower / 2 + center / 2
    return {
      ...group,
      count: rows.length,
      medianLikes,
      aboveMedian: rows.filter(row => row.likes > medianLikes).sort((a, b) => b.likes - a.likes),
    }
  })
}
