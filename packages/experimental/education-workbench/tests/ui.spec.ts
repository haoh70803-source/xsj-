/** Browser verification of the same private creation flow used in day-to-day work. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { INVITATION, PASSWORD, replyEvents, WorkbenchFixture } from './fixture.ts'

it(
  'creates, edits, saves, closes, reopens and continues a script through the real business pages',
  { timeout: 90000 },
  async () => {
    const fixture = await WorkbenchFixture.create([
      { kind: 'sse', events: replyEvents('回归测试首稿：先明确目标，再安排自己的复习。') },
      { kind: 'sse', events: replyEvents('回归测试续改稿：保留本人手动编辑的开场，再展开一个场景。') },
    ])
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await fixture.start()
      browser = await chromium.launch({
        headless: true,
        ...(process.env.EDUCATION_BROWSER_CHANNEL ? { channel: process.env.EDUCATION_BROWSER_CHANNEL } : {}),
      })
      const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: 'zh-CN' })
      let page = await context.newPage()
      const errors: string[] = []
      context.on('page', page =>
        page.on('pageerror', (error) => {
          errors.push(error.message)
          console.error(error.message)
        }),
      )
      page.on('pageerror', (error) => {
        errors.push(error.message)
        console.error(error.message)
      })
      await page.goto(fixture.origin)
      await page.getByRole('button', { name: '使用邀请码加入', exact: true }).click()
      await page.getByLabel('用户名', { exact: false }).fill('browser-editor')
      await page.getByLabel('密码', { exact: false }).fill(PASSWORD)
      await page.getByLabel('团队邀请码', { exact: true }).fill(INVITATION)
      await page.getByRole('button', { name: '创建账号并登录', exact: true }).click()
      await page.locator('header').getByRole('button', { name: '本人画像', exact: true }).click()
      await page.getByLabel('姓名／出镜名称', { exact: true }).fill('回归测试员工')
      await page.getByLabel('本人岗位', { exact: true }).fill('专升本内容运营')
      await page.getByLabel('机构名称', { exact: true }).fill('回归测试机构')
      await page.getByLabel('主要面向谁表达', { exact: true }).fill('广东专科学生')
      await page.getByLabel('表达习惯与口头禅', { exact: true }).fill('自然口语，先讲一个具体问题')
      await page.getByLabel('可以使用的真实经历与事实', { exact: true }).fill('BROWSER_OWN_FACT，仅用于回归测试')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(async () => page.getByText('本人画像已保存。', { exact: true }).isVisible()).toBe(true)
      await page.getByRole('button', { name: '知识库', exact: true }).click()
      await page.getByRole('button', { name: '添加资料', exact: true }).click()
      await page.getByLabel('资料标题', { exact: true }).fill('回归测试授权资料')
      await page.getByLabel('资料正文', { exact: true }).fill('BROWSER_OWN_SOURCE，先明确报考方向，再制定复习计划。')
      await page.getByRole('checkbox', { name: '我确认有权在创作中使用这份资料', exact: true }).check()
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('button', { name: 'AI 创作工作台', exact: true }).click()
      await page.getByLabel('稿件标题', { exact: true }).fill('回归测试口播')
      await page.getByLabel('选题与要求', { exact: true }).fill('解释如何开始准备广东专升本')
      await page.getByRole('checkbox', { name: '回归测试授权资料', exact: true }).check()
      await page.getByRole('button', { name: '创建并保存稿件', exact: true }).click()
      await page.getByRole('button', { name: '生成／继续修改', exact: true }).click()
      const editor = page.getByRole('textbox', { name: '当前稿件', exact: true })
      await expect.poll(async () => editor.inputValue(), { timeout: 15000 }).toContain('回归测试首稿')
      await editor.fill('本人手动编辑的开场：先把目标问清楚。')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(async () => page.getByText('有修改尚未保存', { exact: true }).isVisible()).toBe(false)
      await page.close()
      page = await context.newPage()
      await page.goto(fixture.origin)
      await page.getByRole('button', { name: /回归测试口播/ }).click()
      await expect
        .poll(async () => page.getByRole('textbox', { name: '当前稿件', exact: true }).inputValue())
        .toBe('本人手动编辑的开场：先把目标问清楚。')
      await page
        .getByRole('textbox', { name: '创作或修改要求', exact: true })
        .fill('保留我手动编辑的开场，加入一个具体场景。')
      await page.getByRole('button', { name: '生成／继续修改', exact: true }).click()
      await expect
        .poll(async () => page.getByRole('textbox', { name: '当前稿件', exact: true }).inputValue(), { timeout: 15000 })
        .toContain('回归测试续改稿')
      expect(JSON.stringify(fixture.upstream.requests[1])).toContain('本人手动编辑的开场')
      const artifacts = fileURLToPath(new URL('../../../../.cache/education-proof/', import.meta.url))
      await mkdir(artifacts, { recursive: true })
      await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 375, height: 812 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true })
      await page.getByRole('button', { name: '数据看板', exact: true }).click()
      await page.getByRole('button', { name: '导入数据', exact: true }).click()
      await page.getByLabel('数据来源说明', { exact: true }).fill('浏览器回归测试数据')
      await page.getByLabel('数据采集时间', { exact: true }).fill('2026-01-01T10:00')
      await page
        .getByLabel('作品数据（JSON 数组）', { exact: false })
        .fill(
          JSON.stringify(
            [1, 2, 8, 100].map(likes => ({
              platform: 'douyin',
              account: '回归测试账号',
              title: `测试作品 ${likes}`,
              likes,
              keywords: ['专升本'],
              url: '',
            })),
          ),
        )
      await page.locator('form').getByRole('button', { name: '导入数据', exact: true }).click()
      await expect.poll(async () => page.getByText('5', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: '用作选题', exact: true }).count()).toBe(2)
      await page.getByRole('button', { name: '用作选题', exact: true }).first().click()
      await page.screenshot({ path: join(artifacts, 'topic-flow.png'), fullPage: true })
      expect(await page.getByLabel('选题与要求', { exact: true }).inputValue()).toBe('测试作品 100')
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await fixture.dispose()
    }
  },
)
