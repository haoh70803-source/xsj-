// @vitest-environment jsdom
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { EducationPanel, type WorkspaceFace } from '../src/client/panel.tsx'
import type {} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { fixture, ok, other, projectId, version } from './fixture.client.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
async function bench(signedIn = true) {
  const f = fixture()
  if (!signedIn) f.transport.identity.mockResolvedValue(null)
  await f.model.authenticate()
  if (signedIn) await f.model.open(projectId)
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register('education', { zh, en })
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' } })
  const face: WorkspaceFace = {
    saveProfile: content => f.model.saveProfile(content),
    saveSource: content => f.model.saveSource(content),
    authorizeSource: (source, authorized) => f.model.authorizeSource(source, authorized),
    refreshContext: () => f.model.refreshContext(),
    generate: (instruction, sources, mode, selection) => f.model.generate(instruction, sources, mode, selection),
    cancelGeneration: () => f.model.cancelGeneration(),
    applyCandidate: () => f.model.applyCandidate(),
    setComposing: (value) => {
      f.model.setComposing(value)
    },
    maxTextFileBytes: 1024,
    resetContext: () => f.model.resetContext(),
    hooks: { education: f.model },
    authenticate: credentials => f.model.authenticate(credentials),
    signOut: () => f.model.signOut(),
    list: more => f.model.list(more),
    open: (id, discard) => f.model.open(id, discard),
    create: (title, discard) => f.model.create(title, discard),
    edit: (text) => {
      f.model.edit(text)
    },
    sync: () => f.model.sync(),
    save: () => f.model.save(),
    versions: more => f.model.versions(more),
    preview: value => f.model.preview(value),
    restore: discard => f.model.restore(discard),
    resolve: retry => f.model.resolve(retry),
    exportText: target => f.model.export(target, () => {}),
    dismissNotice: () => {
      f.model.dismissNotice()
    },
  }
  await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.register({ name: 'main', key: 'education', locale: 'education', inject: () => face }, EducationPanel)
    },
  })
  runtime.renderSlot('main', {}, { entryKey: 'education' })
  disposers.push(async () => {
    f.model.dispose()
    await runtime.dispose()
  })
  return { ...f, runtime }
}
it('edits, syncs, saves and previews a historical version through framework-bound model data', async () => {
  const { remote } = await bench()
  fireEvent.change(screen.getByRole('textbox', { name: '当前草稿' }), { target: { value: 'new editor text' } })
  expect(screen.getByRole('status', { name: '草稿同步状态' }).textContent).toContain('有未同步内容')
  expect(screen.getByRole('button', { name: '导出服务器草稿' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '保存正式版本' }))
  await waitFor(() => {
    expect(remote.artifactsSaveVersion).toHaveBeenCalledTimes(1)
  })
  await waitFor(() => {
    expect(screen.getByRole('status', { name: '草稿同步状态' }).textContent).toContain('已同步到服务器')
  })
  fireEvent.click(screen.getByRole('button', { name: '查看版本 1' }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: '历史版本正文（只读）' })).toHaveProperty('value', version.body)
  })
  expect(screen.getByRole('textbox', { name: '当前草稿' })).toHaveProperty('value', 'new editor text')
  fireEvent.click(screen.getByRole('button', { name: '将此版本恢复为草稿' }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: '当前草稿' })).toHaveProperty('value', version.body)
  })
})
it('offers cancel and explicit discard before a server reload loses local edits', async () => {
  await bench()
  fireEvent.change(screen.getByRole('textbox', { name: '当前草稿' }), { target: { value: 'retain me' } })
  fireEvent.click(screen.getByRole('button', { name: '重新读取服务器草稿' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: '取消' }).at(-1)!)
  expect(screen.getByRole('textbox', { name: '当前草稿' })).toHaveProperty('value', 'retain me')
  fireEvent.click(screen.getByRole('button', { name: '重新读取服务器草稿' }))
  fireEvent.click(screen.getByRole('button', { name: '放弃内容并继续' }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: '当前草稿' })).toHaveProperty('value', 'server draft')
  })
})
it('keeps conflicting text visible with actionable recovery', async () => {
  const { remote } = await bench()
  remote.draftsSync.mockResolvedValue({ ok: false, error: new RemoteError('education/DRAFT_CONFLICT', 'safe', {}) })
  fireEvent.change(screen.getByRole('textbox', { name: '当前草稿' }), { target: { value: 'local conflict text' } })
  fireEvent.click(screen.getByRole('button', { name: '同步草稿' }))
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('请先复制内容')
  })
  expect(screen.getByRole('textbox', { name: '当前草稿' })).toHaveProperty('value', 'local conflict text')
})
it('shows result verification and original-request retry while locking new writes', async () => {
  const { remote } = await bench()
  remote.artifactsSaveVersion.mockRejectedValue(new Error('lost response'))
  fireEvent.click(screen.getByRole('button', { name: '保存正式版本' }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '核验原请求结果' })).toHaveProperty('disabled', false)
  })
  expect(screen.getByRole('button', { name: '保存正式版本' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '重试原请求' })).toHaveProperty('disabled', false)
})
it('resets private editor and form state on identity switching without retaining the password', async () => {
  const { model, transport, remote } = await bench()
  await act(async () => {
    model.invalidate()
  })
  expect(screen.queryByRole('textbox', { name: '当前草稿' })).toBeNull()
  expect(screen.queryByText('My private project')).toBeNull()
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: other.username } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic password' } })
  transport.identity.mockResolvedValue(other)
  remote.projectsList.mockResolvedValue(ok({ items: [], nextCursor: null }))
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await waitFor(() => {
    expect(screen.getByText(`当前账号: ${other.username}`)).toBeTruthy()
  })
  expect(screen.queryByDisplayValue('synthetic password')).toBeNull()
  expect(screen.queryByText('My private project')).toBeNull()
})
it('renders empty account state and a retryable login form', async () => {
  await bench(false)
  expect(screen.getByRole('button', { name: '登录' })).toHaveProperty('disabled', false)
  expect(screen.getByLabelText('密码').getAttribute('type')).toBe('password')
  expect(screen.queryByRole('textbox', { name: '当前草稿' })).toBeNull()
})
