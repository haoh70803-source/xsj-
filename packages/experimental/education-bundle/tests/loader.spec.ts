/** Supported dsh headless launches through the real bundle overlay, with no external model requests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dump } from 'js-yaml'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cache = join(repositoryRoot, '.cache', 'education-loader-tests')
const probe = pathToFileURL(fileURLToPath(new URL('./fixtures/probe.mjs', import.meta.url))).href

it.each(['src', 'lib'] as const)('boots, writes and unloads the storage foundation through dsh headless (%s)', { timeout: 45_000 }, async (mode) => {
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'owned-'))
  const databasePath = join(root, 'business.sqlite')
  const patch = join(root, 'fixture.patch.yml')
  writeFileSync(patch, dump([
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { insert: [{ id: 'education-test-probe', name: probe }] },
  ]))
  try {
    const result = await runLoaderSmoke({
      label: `education-foundation-${mode}`, cwd: root,
      binScript: join(repositoryRoot, 'apps/cli/src/bin.ts'),
      configPath: patch, tsconfigPath: join(repositoryRoot, 'tsconfig.json'),
      binArgs: ['--profile', 'headless', '--patch', patch],
      mode, sourceImport: 'tsx/esm',
      prepare: (cwd) => {
        initProfile(join(cwd, '.dsh/profiles/headless'), [
          ...PROFILE_TEMPLATES.headless!.bundles, '@deepseek-ai/dsh-experimental-education-bundle',
        ])
      },
      env: { EDUCATION_DATABASE_PATH: databasePath, DSH_TELEMETRY_DISABLED: 'true',
        DEEPSEEK_API_KEY: 'synthetic-test-key-never-used-for-a-request' },
    })
    expect(result.stdout).toContain('EDUCATION_FOUNDATION_PROBE ')
    expect(result.stdout).toContain('"isolated":true,"closed":true,"versionNo":1')
    const db = new DatabaseSync(databasePath)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()?.count).toBe(2)
      expect(db.prepare('SELECT body FROM artifact_versions').get()?.body).toBe('LOADER_SYNTHETIC_PRIVATE_A')
      expect(db.prepare('SELECT COUNT(*) AS count FROM request_receipts').get()?.count).toBe(4)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  } finally {
    if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-'))) throw new Error('fixture cleanup outside owned root')
    rmSync(root, { recursive: true, force: true })
  }
})
