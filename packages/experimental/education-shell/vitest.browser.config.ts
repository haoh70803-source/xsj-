import { defineConfig } from 'vitest/config'
import web from '../../../vitest.web.config.ts'

export default defineConfig({
  ...web,
  test: { ...web.test, include: ['packages/experimental/education-shell/tests/native-browser.e2e.ts', 'packages/experimental/education-shell/tests/employee-browser.e2e.ts', 'packages/experimental/education-shell/tests/stage-browser.e2e.ts'] },
})
