/** Real named Web Profile, SQLite, employee cookies, generated Remote and built Client modules. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from '../../../../apps/web/tests/scaffold.ts'
import { resolveConfig } from '../../education-storage-sqlite/src/index.ts'
import { SqliteEducationRepository } from '../../education-storage-sqlite/src/repository.ts'
import { createPasswordCredential } from '../../education-identity/src/credentials.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
it('completes native project/draft/version/export flows, clears switched identities and fits 375px', async () => {
  const cache = join(repositoryRoot, '.cache/education-native-client-tests')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'owned-'))
  const databasePath = join(root, 'education.sqlite')
  const repository = await SqliteEducationRepository.open(resolveConfig({ path: databasePath }))
  const organizationId = repository.provisionOrganization('Synthetic native Client organization')
  const password = 'synthetic-native-client-password'
  const credential = await createPasswordCredential(password)
  for (const usernameNormalized of ['client-a', 'client-b']) repository.provisionUser({ organizationId, usernameNormalized, ...credential })
  repository.close()
  const overlay = join(root, 'client.patch.yml')
  writeFileSync(overlay, `
- id: education-storage-sqlite
  config:
    path: ${JSON.stringify(databasePath)}
- id: education-identity-layer
  disabled: false
- id: education-auth-webserver
  disabled: true
- id: education-identity
  inject: [webServer]
  config:
    organizationId: ${JSON.stringify(organizationId)}
    publicOrigin: !!js "'http://127.0.0.1:' + ctx.webServer.port"
    adaptConnection: true
- id: connection
  config:
    requireRequestPolicy: true
- id: education-controller
  disabled: false
- id: education-shell
  disabled: false
`)
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    scaffold = await launchWebScaffold({
      browserCookie: async (baseUrl) => {
        const origin = new URL(baseUrl).origin
        const response = await fetch(`${origin}/education/auth/sign-in`, {
          method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'client-a', password }),
        })
        expect(response.status).toBe(200)
        return response.headers.get('set-cookie')?.split(';')[0] ?? ''
      },
      extraInstallAnchors: [join(repositoryRoot, 'packages/experimental/education-bundle/package.json')],
      extraOverlayPath: [join(repositoryRoot, 'packages/experimental/education-bundle/cordis.patch.yml'), overlay,
        join(repositoryRoot, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    browser = await chromium.launch({ channel: process.env.EDUCATION_BROWSER_CHANNEL ?? 'msedge' })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', acceptDownloads: true })
    const origin = new URL(scaffold.baseUrl).origin
    const login = await context.request.post(`${origin}/education/auth/sign-in`, {
      headers: { Origin: origin }, data: { username: 'client-a', password },
    })
    expect(login.status()).toBe(200)
    const page = await context.newPage()
    const errors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)) })
    const captureFailure = async (): Promise<void> => {
      await page.screenshot({ path: join(cache, 'native-client-failure.png'), fullPage: true }).catch(() => {})
      writeFileSync(join(cache, 'native-client-failure.txt'), JSON.stringify({
        errors, consoleErrors, body: await page.locator('body').innerText().catch(() => ''),
        graphHasEducation: await page.evaluate(() => JSON.stringify(Reflect.get(window, '__DSH_BOOT__')).includes('education-shell')),
      }, null, 2))
    }
    await page.goto(scaffold.baseUrl)
    try {
      await page.getByRole('button', { name: 'Writing workspace', exact: true }).click({ timeout: 15_000 })
    } catch (error) { await captureFailure(); throw error }
    const panel = page.getByRole('region', { name: 'Writing workspace' })
    await panel.getByLabel('Project name').fill('Native employee project')
    await panel.getByRole('button', { name: 'New project', exact: true }).click()
    await panel.getByText('Manuscript and versions', { exact: true }).click()
    const editor = panel.getByRole('textbox', { name: 'Current draft', exact: true })
    await editor.fill('Version one\n中文与空格  ')
    await panel.getByRole('button', { name: 'Save version', exact: true }).click()
    await panel.getByRole('button', { name: 'View version 1', exact: true }).waitFor()
    await editor.fill('Version two\nsecond body')
    await panel.getByRole('button', { name: 'Save version', exact: true }).click()
    await panel.getByRole('button', { name: 'View version 2', exact: true }).waitFor()
    await panel.getByRole('button', { name: 'View version 1', exact: true }).click()
    const preview = panel.getByRole('textbox', { name: 'Historical version text (read only)' })
    await expect.poll(() => preview.inputValue()).toBe('Version one\n中文与空格  ')
    expect(await editor.inputValue()).toBe('Version two\nsecond body')
    await panel.getByRole('button', { name: 'Restore this version as draft', exact: true }).click()
    await expect.poll(() => editor.inputValue()).toBe('Version one\n中文与空格  ')
    await panel.getByRole('button', { name: 'Save version', exact: true }).click()
    await panel.getByRole('button', { name: 'View version 3', exact: true }).waitFor()
    await editor.fill('Draft only text')
    await panel.getByRole('button', { name: 'Sync draft', exact: true }).click()
    await expect.poll(() => panel.getByRole('button', { name: 'Export server draft', exact: true }).isEnabled()).toBe(true)
    for (const [name, body] of [['Export server draft', 'Draft only text'], ['Export viewed version', 'Version one\n中文与空格  ']] as const) {
      const downloaded = page.waitForEvent('download')
      await panel.getByRole('button', { name, exact: true }).click()
      const download = await downloaded
      const path = await download.path()
      expect(path).not.toBeNull()
      expect(readFileSync(path, 'utf8')).toBe(body)
    }
    await page.reload()
    await page.getByRole('button', { name: 'Writing workspace', exact: true }).click()
    await panel.getByRole('button', { name: 'Native employee project', exact: true }).click()
    await expect.poll(() => editor.inputValue()).toBe('Draft only text')
    await panel.evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: join(cache, 'native-client-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 375, height: 812 })
    await panel.getByRole('button', { name: 'View version 1', exact: true }).click()
    await expect.poll(() => preview.inputValue()).toBe('Version one\n中文与空格  ')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await panel.evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: join(cache, 'native-client-375.png'), fullPage: true })
    await page.evaluate(() =>{  document.body.setAttribute('data-ds-dark-theme', '') })
    await page.screenshot({ path: join(cache, 'native-client-375-dark.png'), fullPage: true })
    await editor.fill('Unsynced private A text')
    await panel.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
    await panel.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    expect(await panel.getByText('Native employee project', { exact: true }).count()).toBe(0)
    await panel.getByLabel('Username', { exact: true }).fill('client-b')
    await panel.getByLabel('Password', { exact: true }).fill(password)
    await panel.getByRole('button', { name: 'Sign in', exact: true }).click()
    await panel.getByText('No projects yet. Create a project to begin.', { exact: true }).waitFor()
    expect(await panel.getByText('Native employee project', { exact: true }).count()).toBe(0)
    expect(await panel.textContent()).not.toContain('Unsynced private A text')
    const privateStorage = await page.evaluate(() => Object.values(localStorage)
      .some(value => /Draft only text|Unsynced private/.test(String(value))))
    expect(privateStorage).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await browser?.close(); await scaffold?.close(); repository.close()
    if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-'))) throw new Error('fixture outside owned root')
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
