/** Real built-profile tests for authority, retained edits, restart and model-visible sources. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Profile, Work, WorkspaceView } from '../src/types.ts'
import { analyzeAccounts, emptyWorkspace } from '../src/store.ts'
import { WorkbenchFixture, INVITATION, PASSWORD, replyEvents } from './fixture.ts'

const PROFILE: Profile = {
  displayName: '测试甲',
  role: '专升本课程顾问',
  institution: '回归测试机构',
  audience: '广东专科学生',
  voice: '平实、口语化，先讲具体问题',
  facts: '测试甲的专属事实 A_PRIVATE_FACT',
  forbiddenClaims: '不承诺录取，不编造案例',
}
const fixtures: WorkbenchFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})

async function start(script: Parameters<typeof WorkbenchFixture.create>[0]) {
  const fixture = await WorkbenchFixture.create(script)
  fixtures.push(fixture)
  await fixture.start()
  return fixture
}

describe('education workbench built Harness profile', () => {
  it(
    'keeps private sources and edits through save, restart, dialogue modification and idempotent retry',
    { timeout: 60000 },
    async () => {
      const fixture = await start([
        { kind: 'sse', events: replyEvents('回归测试第一版：先弄清自己的目标，再安排备考。') },
        { kind: 'sse', events: replyEvents('回归测试修改版：先弄清目标。下面用一个具体场景展开。') },
      ])
      const alice = fixture.member()
      const bob = fixture.member()
      expect((await alice.request('/workspace')).status).toBe(401)
      await alice.json('/register', { username: 'alice', password: PASSWORD, invitationCode: INVITATION })
      await bob.json('/register', { username: 'bob', password: PASSWORD, invitationCode: INVITATION })
      await alice.json('/profile', PROFILE)
      await bob.json('/profile', { ...PROFILE, displayName: '测试乙', facts: 'B_PRIVATE_FACT' })
      const bobView = await bob.json<WorkspaceView>('/materials', {
        title: '乙的资料',
        content: 'B_PRIVATE_MATERIAL',
        sourceUrl: '',
        authorized: true,
      })
      let aliceView = await alice.json<WorkspaceView>('/materials', {
        title: '甲的授权资料',
        content: 'A_PRIVATE_MATERIAL：先明确报考目标再安排复习。',
        sourceUrl: 'https://example.com/authorized',
        authorized: true,
      })
      const source = aliceView.materials[0]!
      expect(aliceView.materials).toHaveLength(1)
      expect(
        (
          await alice.request('/works', {
            title: '越权资料',
            kind: 'script',
            topic: '测试',
            sourceIds: [bobView.materials[0]!.id],
          })
        ).status,
      ).toBe(403)
      const created = await alice.json<{ work: Work }>('/works', {
        title: '目标与备考',
        kind: 'script',
        topic: '给广东专科学生讲如何开始准备专升本',
        sourceIds: [source.id],
      })
      expect((await bob.request(`/works/${created.work.id}`)).status).toBe(404)
      const requestId = randomUUID()
      const generated = await alice.json<{ work: Work }>(`/works/${created.work.id}/turn`, {
        revision: created.work.revision,
        instruction: '写一条 60 秒口播稿。',
        requestId,
      })
      expect(generated.work.content).toContain('回归测试第一版')
      const replay = await alice.json<{ work: Work }>(`/works/${created.work.id}/turn`, {
        revision: created.work.revision,
        instruction: '写一条 60 秒口播稿。',
        requestId,
      })
      expect(replay.work.content).toBe(generated.work.content)
      expect(fixture.upstream.requests).toHaveLength(1)
      const body = JSON.stringify(fixture.upstream.requests[0])
      expect(body).toContain('A_PRIVATE_FACT')
      expect(body).toContain('A_PRIVATE_MATERIAL')
      expect(body).not.toContain('B_PRIVATE_FACT')
      expect(body).not.toContain('B_PRIVATE_MATERIAL')
      expect(body).not.toContain('Instructions from: AGENTS.md')
      expect(body).not.toContain('Current runtime context')
      expect(body).not.toContain('"name":"pwsh"')
      expect(body).not.toContain('"name":"bash"')
      const edited = await alice.json<{ work: Work }>(`/works/${created.work.id}`, {
        title: '本人修改后的标题',
        content: '本人直接改过的当前稿：要先问清目标。',
        revision: generated.work.revision,
      })
      expect(
        (
          await alice.request(`/works/${created.work.id}`, {
            title: '过期窗口',
            content: '不应覆盖',
            revision: generated.work.revision,
          })
        ).status,
      ).toBe(409)
      const accounts: unknown = JSON.parse(await readFile(join(fixture.root, 'records/accounts.json'), 'utf8'))
      expect(JSON.stringify(accounts)).not.toContain(PASSWORD)
      await fixture.stop()
      await fixture.start()
      expect((await alice.request('/workspace')).status).toBe(401)
      await alice.json('/login', { username: 'alice', password: PASSWORD })
      aliceView = await alice.json('/workspace')
      expect(aliceView.works[0]!.content).toBe(edited.work.content)
      expect(aliceView.works[0]!.dialogue).toHaveLength(2)
      const changed = await alice.json<{ work: Work }>(`/works/${created.work.id}/turn`, {
        revision: edited.work.revision,
        instruction: '保留我直接改过的开头，再补充一个具体场景。',
        requestId: randomUUID(),
      })
      expect(changed.work.content).toContain('回归测试修改版')
      expect(changed.work.dialogue).toHaveLength(4)
      expect(JSON.stringify(fixture.upstream.requests[1])).toContain('本人直接改过的当前稿')
      expect((await fetch(`${fixture.origin}/api`)).status).toBe(404)
      expect((await fetch(`${fixture.origin}/plugins`)).status).toBe(404)
      const foreignOrigin = await fetch(`${fixture.origin}/business-api/profile`, {
        method: 'POST',
        headers: {
          Cookie: alice.cookie,
          Origin: 'https://other.example',
          'Content-Type': 'application/json',
          'X-Workbench-Request': '1',
        },
        body: JSON.stringify(PROFILE),
      })
      expect(foreignOrigin.status).toBe(403)
    },
  )

  it(
    'retains the original work on provider failure and rejects revoked material, malformed input and uninvited registration',
    { timeout: 45000 },
    async () => {
      const fixture = await start([
        { kind: 'http-error', status: 401, body: JSON.stringify({ error: { message: 'test provider unavailable' } }) },
      ])
      const member = fixture.member()
      expect(
        (await member.request('/register', { username: 'noinvite', password: PASSWORD, invitationCode: 'wrong' }))
          .status,
      ).toBe(403)
      await member.json('/register', { username: 'editor', password: PASSWORD, invitationCode: INVITATION })
      expect((await member.request('/profile', { displayName: 'incomplete' })).status).toBe(400)
      await member.json('/profile', PROFILE)
      const state = await member.json<WorkspaceView>('/materials', {
        title: '授权后撤销',
        content: '测试资料',
        sourceUrl: '',
        authorized: true,
      })
      const material = state.materials[0]!
      const created = await member.json<{ work: Work }>('/works', {
        title: '失败时保留',
        kind: 'moments',
        topic: '测试话题',
        sourceIds: [material.id],
      })
      const edited = await member.json<{ work: Work }>(`/works/${created.work.id}`, {
        title: created.work.title,
        content: '这是一段必须保留的本人原稿。',
        revision: created.work.revision,
      })
      const failed = await member.request(`/works/${created.work.id}/turn`, {
        revision: edited.work.revision,
        instruction: '请修改',
        requestId: randomUUID(),
      })
      expect(failed.status).toBe(502)
      const after = await member.json<WorkspaceView>('/workspace')
      expect(after.works[0]!.content).toBe(edited.work.content)
      expect(after.works[0]!.lastError).toBeTruthy()
      expect(after.works[0]!.pendingRequest).toBeNull()
      expect(after.works[0]!.dialogue).toHaveLength(1)
      await member.json(`/materials/${material.id}`, { revision: material.revision, authorized: false })
      expect(
        (
          await member.request(`/works/${created.work.id}/turn`, {
            revision: after.works[0]!.revision,
            instruction: '重试',
            requestId: randomUUID(),
          })
        ).status,
      ).toBe(403)
      expect(fixture.upstream.requests).toHaveLength(1)
      expect(
        (
          await member.request('/metrics', {
            rows: [{ platform: 'douyin', account: '测试', title: '非法点赞', likes: -1, keywords: [], url: '' }],
            sourceLabel: '测试',
            observedAt: new Date().toISOString(),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await member.request('/works', {
            title: '无效来源',
            kind: 'script',
            topic: '测试',
            sourceIds: ['../../accounts.json'],
          })
        ).status,
      ).toBe(400)
    },
  )

  it('computes even and odd medians independently for each platform and account', () => {
    const state = emptyWorkspace()
    state.metrics = {
      sourceLabel: 'synthetic regression data',
      observedAt: '2026-01-01T00:00:00.000Z',
      importedAt: '2026-01-01T00:00:00.000Z',
      rows: [
        ...[0, 2, 6, 100].map(likes => ({
          platform: 'douyin' as const,
          account: '甲',
          title: `甲${likes}`,
          likes,
          keywords: [],
          url: '',
        })),
        ...[10, 20, 30].map(likes => ({
          platform: 'xiaohongshu' as const,
          account: '甲',
          title: `乙${likes}`,
          likes,
          keywords: [],
          url: '',
        })),
      ],
    }
    const groups = analyzeAccounts(state)
    expect(groups.map(group => group.medianLikes)).toEqual([4, 20])
    expect(groups[0]!.aboveMedian.map(row => row.likes)).toEqual([100, 6])
    expect(groups[1]!.aboveMedian.map(row => row.likes)).toEqual([30])
    expect(analyzeAccounts(emptyWorkspace())).toEqual([])
  })

  it(
    'cancels an owned generation, rejects concurrent writes and invalidates logout cookies',
    { timeout: 45000 },
    async () => {
      const fixture = await start([
        { kind: 'sse', events: replyEvents('这段尚未完整生成的内容不能覆盖本人原稿。'), delayMs: 300 },
      ])
      const member = fixture.member()
      await member.json('/register', { username: 'cancel-editor', password: PASSWORD, invitationCode: INVITATION })
      await member.json('/profile', PROFILE)
      const created = await member.json<{ work: Work }>('/works', {
        title: '取消测试',
        kind: 'script',
        topic: '测试话题',
        sourceIds: [],
      })
      const saved = await member.json<{ work: Work }>(`/works/${created.work.id}`, {
        title: created.work.title,
        content: '取消生成时必须保留的原稿。',
        revision: created.work.revision,
      })
      const pending = member.request(`/works/${created.work.id}/turn`, {
        revision: saved.work.revision,
        instruction: '请修改这条稿件',
        requestId: randomUUID(),
      })
      await expect.poll(() => fixture.upstream.requests.length, { timeout: 5000 }).toBe(1)
      expect(
        (
          await member.request(`/works/${created.work.id}`, {
            title: '并发覆盖',
            content: '禁止覆盖',
            revision: saved.work.revision,
          })
        ).status,
      ).toBe(409)
      expect(
        (
          await member.request(`/works/${created.work.id}/turn`, {
            revision: saved.work.revision,
            instruction: '重复生成',
            requestId: randomUUID(),
          })
        ).status,
      ).toBe(409)
      await member.json(`/works/${created.work.id}/cancel`, {})
      expect((await pending).status).toBe(409)
      const view = await member.json<WorkspaceView>('/workspace')
      expect(view.works[0]!.content).toBe(saved.work.content)
      expect(view.runningWorkIds).toEqual([])
      const oldCookie = member.cookie
      await member.json('/logout', {})
      member.cookie = oldCookie
      expect((await member.request('/workspace')).status).toBe(401)
    },
  )
})
