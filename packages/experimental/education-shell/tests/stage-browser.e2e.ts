/** Four native entries in Edge, real SQLite and employee cookies, with one explicitly synthetic model response. */
import { chromium } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { EmployeeFixture, PASSWORD, nativeReply } from '../../education-bundle/tests/employee-fixture.ts'
import { researchReport } from '../../education-platform/tests/research-fixture.ts'
import type { ResearchSource, SourceDTO, AnalyticsDataset, ContentAccount, ResearchState } from '@deepseek-ai/dsh-experimental-education-platform/types'

const proof = fileURLToPath(new URL('../../../../.cache/education-stage-c-browser-proof/', import.meta.url))
it('uses knowledge, source-only research, real import previews, references, grants and identity fences at desktop and 375px', async () => {
  mkdirSync(proof, { recursive: true })
  const fixture = await EmployeeFixture.create(), errors: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await fixture.start()
    browser = await chromium.launch({ channel: process.env.EDUCATION_BROWSER_CHANNEL ?? 'msedge' })
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'en-US', acceptDownloads: true }), page = await context.newPage()
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(fixture.origin)
    await page.getByLabel('Username', { exact: true }).fill('employee-a'); await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const writing = page.getByRole('region', { name: 'Writing workspace', exact: true }), navigation = page.getByRole('navigation', { name: 'Workbench entries' })
    await writing.getByLabel('Project name', { exact: true }).fill('Phase C browser project')
    await writing.getByRole('button', { name: 'New project', exact: true }).click()
    await writing.getByRole('heading', { name: 'Phase C browser project' }).waitFor()
    const cookie = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    await navigation.getByRole('button', { name: 'Knowledge', exact: true }).click()
    const knowledge = page.getByRole('region', { name: 'Knowledge', exact: true })
    await knowledge.locator('summary').filter({ hasText: 'Confirm source import' }).click()
    const sourceForm = knowledge.locator('form').filter({ has: knowledge.getByLabel('Source title', { exact: true }) })
    await sourceForm.getByLabel('Source title', { exact: true }).fill('Browser original')
    const original = '这是第一段浏览器合成原文，围绕一个具体问题展开。\n\n这是第二段浏览器合成原文，继续解释表达的前后关系。'
    await sourceForm.getByLabel('Source text', { exact: true }).fill(original)
    await sourceForm.getByRole('checkbox', { name: 'I am authorized to import and use this text', exact: true }).check()
    await sourceForm.getByRole('button', { name: 'Confirm source import', exact: true }).click()
    await knowledge.getByRole('button', { name: 'Select for research', exact: true }).waitFor()
    const sources = await fixture.rpc<readonly SourceDTO[]>(cookie, 'sourcesList', {}), source = sources[0]!
    const input = await fixture.rpc<ResearchSource>(cookie, 'researchReadSource', { versionId: source.versionId })
    fixture.upstream.script.push(nativeReply(JSON.stringify(researchReport(input.evidence))))
    const search = knowledge.getByLabel('Source keywords', { exact: true })
    await search.dispatchEvent('compositionstart', { data: '原' }); await search.fill('原文')
    await expect.poll(() => knowledge.getByRole('button', { name: 'Search', exact: true }).isDisabled()).toBe(true)
    await search.dispatchEvent('compositionend', { data: '原文' })
    await knowledge.getByRole('button', { name: 'Select for research', exact: true }).click()
    const research = page.getByRole('region', { name: 'Content research', exact: true })
    await research.getByRole('button', { name: 'Analyze (model call)', exact: true }).click()
    await research.getByRole('heading', { name: 'Core overview', exact: true }).waitFor({ timeout: 15_000 })
    expect(await fixture.rpc(cookie, 'profilesReadSelf', {})).toBeNull()
    await research.getByRole('button', { name: 'Save version', exact: true }).click()
    await research.getByRole('button', { name: 'Preview version', exact: true }).waitFor()
    const downloadPromise = page.waitForEvent('download')
    await research.getByRole('button', { name: 'Export current report', exact: true }).click()
    const download = await downloadPromise, downloadPath = await download.path()
    if (downloadPath === null) throw new Error('controlled report download has no path')
    expect(JSON.parse(readFileSync(downloadPath, 'utf8'))).toMatchObject({ kind: 'research-report', input: { source: { body: original } } })
    await page.screenshot({ path: join(proof, 'research-desktop.png') })
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('synthetic browser clipboard refusal') } } }) })
    await research.getByRole('button', { name: 'Copy current report', exact: true }).click()
    await research.getByRole('alert').filter({ hasText: 'The action did not finish.' }).waitFor()
    expect(await research.getByText('Copied', { exact: true }).count()).toBe(0)
    await research.getByRole('button', { name: 'Use this direction in Writing', exact: true }).click()
    await writing.waitFor()
    await writing.getByRole('checkbox', { name: '把自己的问题讲清楚', exact: true }).waitFor()
    expect(await fixture.rpc(cookie, 'profilesReadSelf', {})).toBeNull()
    await navigation.getByRole('button', { name: 'Account analytics', exact: true }).click()
    const analytics = page.getByRole('region', { name: 'Account analytics', exact: true })
    await analytics.getByText('RedFox is disabled', { exact: false }).waitFor()
    await analytics.locator('summary').filter({ hasText: 'Create private account' }).click()
    await analytics.getByLabel('Platform account identifier', { exact: true }).fill('synthetic-browser-account')
    await analytics.getByLabel('Account name', { exact: true }).fill('Browser private account')
    await analytics.locator('form').filter({ has: analytics.getByLabel('Account name', { exact: true }) }).getByRole('button', { name: 'Create private account', exact: true }).click()
    await analytics.locator('summary').filter({ hasText: 'Data import: preview and confirm' }).click()
    const importForm = analytics.locator('form').filter({ has: analytics.getByLabel('Actual source description', { exact: true }) })
    const metricFile = { kind: 'education-metrics', version: 1, overview: { followers: 0, totalLikes: 1000 }, contents: [
      { externalId: 'zero', kind: 'video', title: 'Imported zero', publishedAt: new Date(Date.now() - 86_400_000).toISOString(), likes: 0, comments: null },
      { externalId: 'missing', kind: 'video', title: 'Imported missing', publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), likes: null },
      { externalId: 'image', kind: 'image', title: 'Imported image', publishedAt: new Date(Date.now() - 86_400_000).toISOString(), likes: 99 },
    ] }
    await importForm.getByLabel('Actual source description', { exact: true }).fill('Browser supplied file')
    await importForm.getByLabel('Observed at (ISO time with zone)', { exact: true }).fill(new Date(Date.now() - 1000).toISOString())
    await importForm.getByLabel('Source text', { exact: true }).fill(JSON.stringify(metricFile))
    await importForm.getByRole('button', { name: 'Prepare import preview', exact: true }).click()
    await analytics.getByRole('button', { name: 'Confirm this preview', exact: true }).click()
    await analytics.getByRole('heading', { name: 'Imported zero', exact: true }).waitFor()
    const accounts = await fixture.rpc<readonly ContentAccount[]>(cookie, 'analyticsAccountsList', {}), account = accounts[0]!
    const data = await fixture.rpc<AnalyticsDataset>(cookie, 'analyticsQuery', { accountId: account.id, source: 'import:Browser supplied file', mode: 'latest', keyword: '' })
    expect(data.analysis).toMatchObject({ medianLikes: 0, validSampleCount: 1, baselineCount: 2 }); expect(data.analysis.images).toHaveLength(1)
    await page.setViewportSize({ width: 375, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await page.screenshot({ path: join(proof, 'analytics-375.png') })
    const row = analytics.locator('li').filter({ has: analytics.getByRole('heading', { name: 'Imported zero', exact: true }) })
    await row.getByRole('button', { name: 'Use in current project', exact: true }).click()
    await expect.poll(() => analytics.getByRole('button', { name: 'Research the supplied original', exact: true }).isDisabled()).toBe(true)
    await analytics.getByLabel('Authorized original text (required for research)', { exact: true }).fill('这是用户提供的另一份获准原文，指标和标题不能代替它。')
    await analytics.getByRole('button', { name: 'Research the supplied original', exact: true }).click()
    await research.waitFor(); expect(fixture.upstream.requests).toHaveLength(1)
    const projectPage = await fixture.rpc<{ items: readonly { id: string }[] }>(cookie, 'projectsList', { limit: 1 })
    const reportArtifact = await fixture.rpc<{ artifactId: string }>(cookie, 'researchEnsureArtifact', { projectId: projectPage.items[0]!.id, requestId: randomUUID() })
    const report = await fixture.rpc<ResearchState>(cookie, 'researchOpen', { artifactId: reportArtifact.artifactId })
    await fixture.rpc(cookie, 'sourcesSetAuthorization', { sourceId: source.id, authorized: false, expectedAuthorizationRevision: 1, requestId: randomUUID() })
    await research.getByRole('alert').filter({ hasText: 'A source was revoked.' }).waitFor({ timeout: 10_000 })
    expect((await fixture.rpc<ResearchState>(cookie, 'researchOpen', { artifactId: report.artifact.id })).draft.body).toBe('')
    await navigation.getByRole('button', { name: 'Writing', exact: true }).click()
    await writing.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByLabel('Username', { exact: true }).fill('employee-b'); await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await navigation.getByRole('button', { name: 'Knowledge', exact: true }).click(); await knowledge.getByText('No matching authorized sources.', { exact: false }).waitFor()
    expect(await page.getByText('Browser original', { exact: true }).count()).toBe(0)
    const privateStorage = await page.evaluate(() => Object.values(localStorage).some(value => /浏览器合成原文|Browser private account|Phase C browser project/.test(String(value))))
    expect(privateStorage).toBe(false); expect(fixture.upstream.requests).toHaveLength(1); expect(errors).toEqual([])
    writeFileSync(join(proof, 'result.json'), JSON.stringify({ nativeProfile: true, viewport: [1280, 375], syntheticModelCalls: fixture.upstream.requests.length, liveModelCalls: 0, liveRedFoxCalls: 0, pageErrors: errors }, null, 2))
  } finally { await browser?.close(); await fixture.dispose() }
}, 180_000)
