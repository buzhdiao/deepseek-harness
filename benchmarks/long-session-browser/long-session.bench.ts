/** Required browser budgets for opening, paging and continuing synthetic long history. */
// 文件头（JSDoc 补充）：浏览器端打开、翻页与续跑合成超长历史所需的性能预算。
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Page, type CDPSession, type Locator } from 'playwright'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import { HISTORY_TURNS, SESSION_ID, FIRST, DONE, DELTAS, PACE_MS, syntheticHistory, syntheticReply } from './synthetic-history.ts'

// 每个端点（endpoint）的重复采样次数。
const SAMPLES = 3
// 回合尾部（turn-tail）元素的选择器：用前缀匹配定位翻页计数依据。
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
// 参考机各端点的裸期望毫秒数（作为基准参照）。
const REFERENCE = { open: 200, page: 260, trajectory: 160, first: 1100, streamTask: 1800, input: 500, streamWall: 1000 }
// CI 环境下观察到的期望值：打开、翻页、Trajectory 视图。
const EXPECTED_OPEN_CI_MS = 900
const EXPECTED_PAGE_CI_MS = 700
const EXPECTED_TRAJECTORY_CI_MS = 520
// 三个端点的正式预算 = 期望值 × 波动余量系数（headroom）。
const OPEN_BUDGET_MS = Math.ceil(EXPECTED_OPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const PAGE_BUDGET_MS = Math.ceil(EXPECTED_PAGE_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const TRAJECTORY_BUDGET_MS = Math.ceil(EXPECTED_TRAJECTORY_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
// 节奏回放的总时长：(chunk 数 + 4) × 每 chunk 延迟，用于补偿 streamWall 预算中的回放等待。
const REPLAY_DURATION_MS = (DELTAS + 4) * PACE_MS
/** Endpoints without paced replay waits, so CPU scaling applies to their whole duration. */
// 中文补充（常量 JSDoc）：这些端点不含节奏化回放等待，因此整体耗时都适用 CPU 缩放系数。
const SCALED_ENDPOINTS = ['open', 'page', 'trajectory', 'streamTask'] as const
/** Estimated storage wait: the Host reads the seeded Session log, which the page cache usually holds. */
// 中文补充（常量 JSDoc）：估算存储等待占比 5%：Host 读取已播种的 Session 日志，通常命中页缓存。
const IO_SHARE = 0.05
// 用例元信息：id、测什么、影响什么。
const CASE: BenchmarkCase = {
  id: 'long-session-browser',
  measures: 'Chromium on the built Web GUI: opening a 240-turn Session, the slowest older page, first Trajectory view, and main-thread task time while a reply streams.',
  affects: 'Everyday Web GUI use with a long Session.',
}

// 等待页面真正完成绘制：串联两次 requestAnimationFrame。
async function painted(page: Page): Promise<void> {
  // Two rAF callbacks include a rendering opportunity, not a GPU presentation timestamp.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

// 通用测量：记录开始时间、执行动作、等待绘制完成，返回耗时（时钟可注入便于测试）。
async function measure(page: Page, action: () => Promise<void>, now = () => performance.now()): Promise<number> {
  const start = now()
  await action()
  await painted(page)
  return now() - start
}

/** Time one trusted paging action after resolving its unique button. */
// 中文补充（函数 JSDoc）：解析出唯一的翻页按钮后，对一次受信任（trusted）的翻页点击计时。
async function measureOlderPage(page: Page, previous: number, now = () => performance.now()): Promise<number> {
  // 定位"Load earlier"按钮并等待其挂载。
  const locator = page.getByRole('button', { name: 'Load earlier', exact: true })
  await locator.waitFor({ state: 'attached' })
  // 拿到元素句柄并确保恰好只有一个，避免歧义选择器污染计时。
  const buttons = await locator.elementHandles()
  try {
    expect(buttons).toHaveLength(1)
    return await measure(page, async () => {
      await buttons[0]!.click()
      // 点击后等待尾部元素数量超过 previous，确认新页面已加载。
      await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous, { selector: TAIL, previous })
    }, now)
  } finally {
    // 无论成败都释放句柄。
    await Promise.all(buttons.map(button => button.dispose()))
  }
}

// 从 CDP 的 Performance.getMetrics 中读取主线程任务总时长 TaskDuration（秒转毫秒）。
async function taskMs(cdp: CDPSession): Promise<number> {
  const result = await cdp.send('Performance.getMetrics')
  const metric = result.metrics.find(metric => metric.name === 'TaskDuration')
  if (metric === undefined) throw new Error('Chromium TaskDuration missing')
  return metric.value * 1000
}

// 计算中位数。
function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

// 断言端点耗时不超过预算。
function expectEndpointWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

// 断言输入重叠（input overlap）标志为真：输入探针必须在流式期间被触发过。
function expectInputOverlap(value: boolean): void {
  expect(value).toBe(true)
}

// 等待最新 Assistant 步骤中出现可见的标记文本，并返回观察对象（含时间、焦点与首尾标记状态）。
async function waitForReplyMarker(page: Page, marker: string, timeout = 30000) {
  return page.waitForFunction(({ marker, first, done }) => {
    // 取最后一个 assistant-step 节点作为当前回复。
    const reply = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)
    if (!reply) return false
    // 遍历回复内所有文本节点，寻找包含标记且可见的节点。
    const text = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = text.nextNode())) {
      // 不可见或不包含标记的节点跳过。
      if (!node.textContent?.includes(marker) || !node.parentElement?.checkVisibility({ checkVisibilityCSS: true })) continue
      // 找到后同时采集输入框焦点与全文的首尾标记状态。
      const composer = Array.from(document.querySelectorAll('[data-composer-input][contenteditable="true"]')).at(-1)
      const transcript = reply.textContent ?? ''
      return { atMs: window.performance.now(), focused: document.activeElement === composer, first: transcript.includes(first), done: transcript.includes(done) }
    }
    return false
  }, { marker, first: FIRST, done: DONE }, { polling: 'raf', timeout })
}

// 等待 Trajectory 视图就绪：搜索框可见且有至少一行可见记录。
async function waitForTrajectory(page: Page, timeout = 30000): Promise<void> {
  // Selector retry backoff can delay observation after the view is already ready.
  const ready = await page.waitForFunction(() => {
    // 搜索框必须可见。
    const search = document.querySelector('input[type="search"][aria-label="Search trajectory"]')
    if (!search?.checkVisibility({ checkVisibilityCSS: true })) return false
    // 且轨迹行中至少一行可见（排除无关表格行）。
    return Array.from(document.querySelectorAll('[data-trajectory-scroll] [data-trajectory-row-key]'))
      .some(row => row.checkVisibility({ checkVisibilityCSS: true }))
  }, undefined, { polling: 'raf', timeout })
  await ready.dispose()
}

// 在输入框上挂一次性 input 事件探针：记录输入是否与流式回复的"已出 FIRST 未出 DONE"窗口重叠。
async function watchInputOverlap(composer: Locator): Promise<void> {
  await composer.evaluate((element, markers) => {
    // 每次安装前先清掉上一轮的见证属性。
    element.removeAttribute('data-benchmark-input-witness')
    element.removeAttribute('data-benchmark-input-overlap')
    element.removeAttribute('data-benchmark-input-timing')
    element.addEventListener('input', (event) => {
      const transcript = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
      // overlap 标志 = 事件受信任 且 已看到 FIRST 且 还没看到 DONE。
      element.setAttribute('data-benchmark-input-overlap', String(event.isTrusted && transcript.includes(markers.first) && !transcript.includes(markers.done)))
      // 见证属性记录原始事实，供失败时人工诊断。
      element.setAttribute('data-benchmark-input-witness', JSON.stringify({ trusted: event.isTrusted, first: transcript.includes(markers.first), done: transcript.includes(markers.done) }))
      element.setAttribute('data-benchmark-input-timing', JSON.stringify({ atMs: window.performance.now(), eventAtMs: event.timeStamp, focused: document.activeElement === element }))
    }, { once: true })
  }, { first: FIRST, done: DONE })
}

// 用例一：对录制的托管打开样本做预算自洽性校验。
it('accepts recorded hosted open samples and rejects slower endpoints', () => {
  // 两个历史录制样本。
  for (const value of [681.276514, 541.051233]) {
    // 参考机裸预算（200ms 经 CI 系数）容纳不了它们——必须抛错。
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(REFERENCE.open))).toThrow()
    // 但正式打开预算必须接受。
    expectEndpointWithinBudget(value, OPEN_BUDGET_MS)
  }
  // 第三组样本取中位数。
  const repeatedMedian = median([875.306861, 1083.683529, 814.700998])
  expect(repeatedMedian).toBe(875.306861)
  // 裸参考预算与 875ms 阈值都应拒绝它。
  expect(() => expectEndpointWithinBudget(repeatedMedian, ciTimeBudget(REFERENCE.open))).toThrow()
  expect(() => expectEndpointWithinBudget(repeatedMedian, 875)).toThrow()
  // 正式预算必须接受。
  expectEndpointWithinBudget(repeatedMedian, OPEN_BUDGET_MS)
  // 锁定打开预算恰为 1125ms。
  expect(OPEN_BUDGET_MS).toBe(1125)
  // 预算+1 与 2000ms 都必须被拒绝。
  expect(() => expectEndpointWithinBudget(OPEN_BUDGET_MS + 1, OPEN_BUDGET_MS)).toThrow()
  expect(() => expectEndpointWithinBudget(2000, OPEN_BUDGET_MS)).toThrow()
})

// 用例二：对录制的翻页与 Trajectory 中位数做预算自洽性校验。
it('accepts recorded hosted paging and Trajectory medians and rejects slower endpoints', () => {
  // 三组端点样本：一组翻页、两组 Trajectory（不同托管环境）。
  const endpoints = [
    { samples: [843.941625, 672.834329, 684.461818], reference: REFERENCE.page, budget: PAGE_BUDGET_MS, expectedBudget: 875 },
    { samples: [605.788061, 367.754027, 485.931656], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
    { samples: [630.843184, 418.578099, 635.550009], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
  ]
  for (const { samples, reference, budget, expectedBudget } of endpoints) {
    const value = median(samples)
    // 裸参考预算必须拒绝（样本比参考机慢）。
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(reference))).toThrow()
    // 正式预算必须接受且数值锁定。
    expectEndpointWithinBudget(value, budget)
    expect(budget).toBe(expectedBudget)
    // 预算+1 必须被拒绝。
    expect(() => expectEndpointWithinBudget(budget + 1, budget)).toThrow()
  }
})

// 用例三：验证 waitForReplyMarker 只认可见文本节点。
it('waits for visible marker text in the latest Assistant step', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // 造两个 assistant-step：一个含可见 FIRST，一个含 visibility:hidden 的 FIRST。
    await page.setContent(`<div data-chat-flow-kind="assistant-step">${FIRST}</div><div data-chat-flow-kind="assistant-step"><span style="visibility:hidden">${FIRST}</span></div>`)
    // 标记只在隐藏节点中时必须超时。
    await expect(waitForReplyMarker(page, FIRST, 100)).rejects.toThrow('Timeout')
    // 把隐藏节点改为可见后，等待应成功并报告 first=true、done=false。
    await page.locator('span').evaluate(element => { element.style.visibility = 'visible' })
    const observation = await waitForReplyMarker(page, FIRST)
    expect(await observation.jsonValue()).toMatchObject({ first: true, done: false })
    await observation.dispose()
    // DONE 标记不存在时仍应超时。
    await expect(waitForReplyMarker(page, DONE, 100)).rejects.toThrow('Timeout')
  } finally {
    await browser.close()
  }
})

// 用例四：验证 waitForTrajectory 只认可见搜索框与可见轨迹行。
it('waits for visible Trajectory controls and records rather than unrelated table rows', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // 造一个隐藏搜索框 + 无关表格 + 一个含可见记录行的轨迹容器。
    await page.setContent('<input type="search" aria-label="Search trajectory" style="visibility:hidden"><table><tbody><tr><td>unrelated</td></tr></tbody></table><div data-trajectory-scroll><table><tbody><tr data-trajectory-row-key="record"><td>record</td></tr></tbody></table></div>')
    // 搜索框不可见 → 必须超时。
    await expect(waitForTrajectory(page, 100)).rejects.toThrow('Timeout')
    // 隐藏记录行后（即使搜索框恢复可见）仍应超时——无关行不算数。
    await page.locator('[data-trajectory-row-key]').evaluate(element => { element.style.display = 'none' })
    await page.locator('input').evaluate(element => { element.style.visibility = 'visible' })
    await expect(waitForTrajectory(page, 100)).rejects.toThrow('Timeout')
    // 恢复显示记录行后等待应成功。
    await page.locator('[data-trajectory-row-key]').evaluate(element => { element.style.display = 'table-row' })
    await waitForTrajectory(page)
  } finally {
    await browser.close()
  }
})

// 用例五：验证 measureOlderPage 把选择器准备时间排除在计时之外，但点击必须是受信任的。
it('excludes older-page selector preparation while retaining the trusted click', async () => {
  const browser = await chromium.launch({ headless: true })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    // 造一个翻页按钮与一个尾部元素。
    await page.setContent('<button type="button">Load earlier</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      // 按钮点击时记录 isTrusted 并追加新尾部元素。
      button.addEventListener('click', event => {
        button.setAttribute('data-click-trusted', String(event.isTrusted))
        const tail = document.createElement('div')
        tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
        document.body.append(tail)
      })
    })
    const button = page.getByRole('button', { name: 'Load earlier', exact: true })
    // 保留原始方法引用，供 mock 包装后调用。
    const click = button.click.bind(button)
    const elementHandles = button.elementHandles.bind(button)
    // 准备屏障：进入后挂起直到放行。
    const prepare = async (): Promise<void> => { entered.resolve(undefined); await release.promise }
    vi.spyOn(page, 'getByRole').mockReturnValue(button)
    // The Locator spy gates preparation in the original selector-inside-timer control.
    vi.spyOn(button, 'click').mockImplementation(async options => { await prepare(); await click(options) })
    vi.spyOn(button, 'elementHandles').mockImplementation(async () => { await prepare(); return elementHandles() })
    let now = 0
    // 用注入的固定时钟启动测量。
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    // 等到准备屏障被触发，且期间测量不得提前完成。
    await Promise.race([
      entered.promise,
      operation.then(outcome => {
        if ('error' in outcome) throw outcome.error
        throw new Error('Paging completed before the selector preparation barrier')
      }),
    ])
    // 屏障期间点击尚未发生。
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBeNull()
    expect(await page.locator(TAIL).count()).toBe(1)
    // 把固定时钟拨到预算之外再放行——若准备时间被计入就会超标。
    now = PAGE_BUDGET_MS + 1
    release.resolve(undefined)
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    // 耗时预算内（实际为 0，因为时钟拨动发生在动作开始前）。
    expectEndpointWithinBudget(outcome.value, PAGE_BUDGET_MS)
    expect(outcome.value).toBe(0)
    // 放行后点击真正发生且为受信任点击，尾部元素数量变为 2。
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBe('true')
    expect(await page.locator(TAIL).count()).toBe(2)
  } finally {
    release.resolve(undefined)
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

// 用例六：验证 measureOlderPage 在开始计时前会等待指定的（非 disabled）翻页控件就绪。
it('waits for a named older-page control before starting its clock', async () => {
  const browser = await chromium.launch({ headless: true })
  const entered = Promise.withResolvers<undefined>()
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    // 初始按钮处于 disabled 的"Loading…"状态——还不是目标控件。
    await page.setContent('<button type="button" disabled>Loading…</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      button.addEventListener('click', event => {
        button.setAttribute('data-click-trusted', String(event.isTrusted))
        const tail = document.createElement('div')
        tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
        document.body.append(tail)
      })
    })
    const locator = page.getByRole('button', { name: 'Load earlier', exact: true })
    const waitFor = locator.waitFor.bind(locator)
    vi.spyOn(page, 'getByRole').mockReturnValue(locator)
    // mock waitFor：进入时先发出已进入信号，再执行原逻辑。
    vi.spyOn(locator, 'waitFor').mockImplementation(options => { entered.resolve(undefined); return waitFor(options) })
    let now = 0
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    // 等到 waitFor 被调用，且测量不得在此之前完成。
    await Promise.race([
      entered.promise,
      operation.then(outcome => {
        if ('error' in outcome) throw outcome.error
        throw new Error('Paging completed before control readiness')
      }),
    ])
    // 控件就绪前不会有点击。
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBeNull()
    // 拨快时钟（模拟控件就绪耗时）再真正启用按钮。
    now = PAGE_BUDGET_MS + 1
    await page.locator('button').evaluate(button => {
      button.textContent = 'Load earlier'
      button.removeAttribute('disabled')
    })
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    // 控件等待时间不计入测量（时钟为固定 0 起点后的动作耗时）。
    expect(outcome.value).toBe(0)
    // 点击为受信任且翻页成功。
    expect(await page.locator('button').getAttribute('data-click-trusted')).toBe('true')
    expect(await page.locator(TAIL).count()).toBe(2)
  } finally {
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

// 用例七：验证固定测量时钟不会让浏览器侧超时机制失效。
it('keeps browser deadlines active with a fixed measurement clock', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // 时钟恒为 0，但 waitForFunction 的 100ms 浏览器超时仍必须触发。
    await expect(measure(page, async () => {
      const pending = await page.waitForFunction(() => false, undefined, { timeout: 100 })
      await pending.dispose()
    }, () => 0)).rejects.toThrow('Timeout 100ms exceeded')
  } finally {
    await browser.close()
  }
})

// 用例八：验证超过翻页上限的渲染耗时会被正确拒绝。
it('rejects older-page rendering beyond the unchanged paging ceiling', async () => {
  const browser = await chromium.launch({ headless: true })
  let operation: Promise<{ value: number } | { error: unknown }> | undefined
  try {
    const page = await browser.newPage()
    await page.setContent('<button type="button">Load earlier</button><div data-chat-flow-key="9:turn-tail"></div>')
    await page.locator('button').evaluate(button => {
      button.addEventListener('click', event => { button.setAttribute('data-click-trusted', String(event.isTrusted)) })
    })
    let now = 0
    operation = measureOlderPage(page, 1, () => now).then(value => ({ value }), (error: unknown) => ({ error }))
    // 等到受信任点击发生。
    await page.waitForFunction(() => document.querySelector('button')?.getAttribute('data-click-trusted') === 'true')
    // 点击之后、页面渲染完成之前把时钟拨到预算之外。
    now = PAGE_BUDGET_MS + 1
    // 此刻再追加尾部元素，模拟超时渲染。
    await page.evaluate(() => {
      const tail = document.createElement('div')
      tail.setAttribute('data-chat-flow-key', '9:turn-tail:next')
      document.body.append(tail)
    })
    const outcome = await operation
    if ('error' in outcome) throw outcome.error
    // 测量值 = 拨动后的时钟读数，必须超出预算并被断言拒绝。
    expect(outcome.value).toBe(PAGE_BUDGET_MS + 1)
    expect(() => expectEndpointWithinBudget(outcome.value, PAGE_BUDGET_MS)).toThrow()
  } finally {
    try { await browser.close() } finally {
      try { await operation } finally { vi.restoreAllMocks() }
    }
  }
})

// 用例九：验证歧义或被替换的翻页按钮会在翻页前被拒绝。
it('rejects ambiguous or replaced older-page buttons before paging', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // 两个同名按钮 → 严格模式违规，必须抛错。
    await page.setContent('<button type="button">Load earlier</button><button type="button">Load earlier</button>')
    await expect(measureOlderPage(page, 0)).rejects.toThrow('strict mode violation')
    // 恢复单按钮，但让 elementHandles 返回后立即把节点替换掉。
    await page.setContent('<button type="button">Load earlier</button>')
    const button = page.getByRole('button', { name: 'Load earlier', exact: true })
    const elementHandles = button.elementHandles.bind(button)
    vi.spyOn(page, 'getByRole').mockReturnValue(button)
    vi.spyOn(button, 'elementHandles').mockImplementation(async () => {
      const handles = await elementHandles()
      // 用克隆节点替换原节点，使句柄脱离 DOM。
      await button.evaluate(element => { element.replaceWith(element.cloneNode(true)) })
      return handles
    })
    // 句柄失联 → 必须在点击前抛"Element is not attached"。
    await expect(measureOlderPage(page, 0)).rejects.toThrow('Element is not attached')
  } finally {
    try { await browser.close() } finally { vi.restoreAllMocks() }
  }
})

// 正式基准：打开、翻页、切视图并向 240 回合的浏览器历史续跑。
it('opens, pages, navigates and streams into a 240-turn browser history', async () => {
  // 浏览器基准只能在无密钥回放（replay）模式下运行。
  if (webSnapshotMode() !== 'replay') throw new Error('browser benchmarks require keyless replay mode')
  // 各次采样的指标集合。
  const samples: { open: number; page: number; trajectory: number; first: number; streamTask: number; streamWall: number; input: number; inputOverlapped: boolean; heapMb: number; nodes: number }[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    // 收集本采样中所有清理/运行失败，最后统一聚合抛出。
    const failures: unknown[] = []
    // 为本采样创建隔离的临时目录。
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-benchmark-'))
    try {
      // 写回放覆盖文件：定义一次以合成 chunk 序列组成的回复。
      const replayOverride = join(root, 'reply.json')
      await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: syntheticReply() }]))
      // 启动 Web 脚手架：回放夹具、节奏延迟、超大上下文窗口。
      const scaffold = await launchWebScaffold({ replayFixture: join(root, 'override-only.jsonl'), replayOverride, paceMs: PACE_MS, replayContextWindow: 10000000 })
      try {
        // 生成 240 回合的合成历史并播种到脚手架。
        const history = syntheticHistory()
        await seedSession(scaffold, history, SESSION_ID)
        console.log(JSON.stringify({ benchmark: 'long-session-browser/fixture', bytes: Buffer.byteLength(history) }))
        // 启动无头 Chromium。
        const browser = await chromium.launch({ headless: true })
        try {
          // 新建英文界面页面并监听控制台错误/警告。
          const page = await newEnglishPage(browser)
          const consoleWatch = watchConsole(page)
          page.setDefaultTimeout(30000)
          // 打开已认证的脚手架 URL。
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
          console.log(JSON.stringify({ benchmark: 'long-session-browser/server', url: scaffold.baseUrl, browser: browser.version(), sample }))
          // 等待界面框架渲染，展开会话树并选中第二个树项（目标会话）。
          await page.waitForSelector('[class*="frame"]')
          await page.getByRole('treeitem').first().click()
          const result = page.getByRole('treeitem').nth(1)
          await result.waitFor()
          // 测量"打开"耗时：点击会话直到尾部与输入框出现。
          const open = await measure(page, async () => {
            await result.click()
            await page.locator(TAIL).last().waitFor()
            await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor()
          })
          // 循环翻页直到加载全部 240 回合，记录每次翻页耗时。
          const pages: number[] = []
          const initialTurns = await page.locator(TAIL).count()
          expect(initialTurns).toBeGreaterThan(0)
          expect(initialTurns).toBeLessThan(HISTORY_TURNS)
          let count = initialTurns
          while (count < HISTORY_TURNS) {
            pages.push(await measureOlderPage(page, count))
            count = await page.locator(TAIL).count()
          }
          // 测量首次切到 Trajectory 视图的耗时。
          const trajectory = await measure(page, async () => {
            await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
            await waitForTrajectory(page)
          })
          // 切回 Chat 视图并确认全部回合都在。
          await page.getByRole('tab', { name: 'Chat', exact: true }).click()
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS })
          // 填入超长续跑提示词，并开启 CDP 性能指标。
          const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
          await composer.fill('Continue the synthetic review and summarize the validation. '.repeat(30))
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Performance.enable')
          // 记录流式开始前的任务时长基线。
          const beforeTask = await taskMs(cdp)
          // 等待回合落定（settle），错误会被包装后延迟抛出。
          const settled = scaffold.whenTurnSettled(60000).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          // 安装输入探针。
          await watchInputOverlap(composer)
          // 发送回车，开始流式回复，测出首个标记出现时间。
          const started = performance.now()
          await page.keyboard.press('Enter')
          const firstMarker = await waitForReplyMarker(page, FIRST)
          const first = performance.now() - started
          // Keep focus across submission; mouse actionability must not delay the input probe.
          const input = await measure(page, async () => {
            await page.keyboard.type('next synthetic question')
            await expect.poll(() => composer.textContent()).toBe('next synthetic question')
          })
          // 读取输入重叠标志并收集首标记观察详情。
          const inputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          const firstObservation = await firstMarker.jsonValue()
          await firstMarker.dispose()
          console.log(JSON.stringify({ benchmark: 'long-session-browser/input', sample, first, input, firstObservation, witness: await composer.getAttribute('data-benchmark-input-witness'), inputTiming: await composer.getAttribute('data-benchmark-input-timing') }))
          // 输入必须发生在流式窗口内（重叠为真）。
          expectInputOverlap(inputOverlapped)
          // 等待完成标记与回合落定。
          await (await waitForReplyMarker(page, DONE)).dispose()
          const settlement = await settled
          if (!settlement.ok) throw settlement.error
          // 确认新增了一个回合，等待绘制完成后统计流式墙钟与主线程任务时长。
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS + 1 })
          await painted(page)
          const streamWall = performance.now() - started
          const streamTask = await taskMs(cdp) - beforeTask
          // 强制 GC 后读取堆指标。
          await cdp.send('HeapProfiler.collectGarbage')
          const metrics = (await cdp.send('Performance.getMetrics')).metrics
          const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')
          if (heap === undefined) throw new Error('Chromium heap metric missing')
          // 保存本采样全部指标。
          samples.push({ open, page: Math.max(...pages), trajectory, first, streamTask, streamWall, input, inputOverlapped, heapMb: heap.value / 1048576, nodes: await page.locator('*').count() })
          console.log(JSON.stringify({ benchmark: 'long-session-browser/sample', sample, initialTurns, pages, ...samples.at(-1) }))
          // 落定后再次安装探针并输入：此时 FIRST 与 DONE 均已出现，重叠必须为假。
          await watchInputOverlap(composer)
          await composer.click()
          await page.keyboard.type('!')
          const lateInputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          expect(await composer.getAttribute('data-benchmark-input-witness')).toBe(JSON.stringify({ trusted: true, first: true, done: true }))
          expect(() => expectInputOverlap(lateInputOverlapped)).toThrow()
          // 控制台不得出现页面错误或警告。
          expect(consoleWatch.pageErrors).toEqual([])
          expect(consoleWatch.warnings).toEqual([])
        } catch (error) { failures.push(error) } finally {
          // 关闭浏览器，关闭失败也记录下来。
          await browser.close().catch((error: unknown) => failures.push(error))
        }
      } catch (error) { failures.push(error) } finally {
        // 关闭脚手架。
        await scaffold.close().catch((error: unknown) => failures.push(error))
      }
    } catch (error) { failures.push(error) } finally {
      // 删除临时目录。
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    // 本采样存在任何失败则聚合抛出。
    if (failures.length > 0) throw new AggregateError(failures, 'browser benchmark failed')
  }
  // 对所有指标取三次采样的中位数。
  const aggregate = Object.fromEntries(Object.keys(REFERENCE).map(key => [key, median(samples.map(sample => sample[key as keyof typeof REFERENCE]))]))
  // 计算各指标预算：默认 ciTimeBudget(参考值)，streamWall 追加回放时长补偿；open/page/trajectory 用专用预算。
  const budgets: Record<string, number> = {
    ...Object.fromEntries(Object.entries(REFERENCE).map(([key, value]) => [key, ciTimeBudget(value) + (key === 'streamWall' ? REPLAY_DURATION_MS : 0)])),
    open: OPEN_BUDGET_MS, page: PAGE_BUDGET_MS, trajectory: TRAJECTORY_BUDGET_MS,
  }
  console.log(JSON.stringify({ benchmark: 'long-session-browser/median', turns: HISTORY_TURNS, deltas: DELTAS, paceMs: PACE_MS, samples, aggregate, referenceMs: REFERENCE, expectedOpenCiMs: EXPECTED_OPEN_CI_MS, expectedPageCiMs: EXPECTED_PAGE_CI_MS, expectedTrajectoryCiMs: EXPECTED_TRAJECTORY_CI_MS, budgets }))
  // 把适用 CPU 缩放的端点指标连同预算写入缩放报告。
  recordTimings(CASE, Object.fromEntries(SCALED_ENDPOINTS.map(key => [key, { ms: aggregate[key]!, ioShare: IO_SHARE }])), budgets)
  // 全部聚合指标逐一校验预算。
  for (const [key, value] of Object.entries(aggregate)) expectEndpointWithinBudget(value, budgets[key]!)
})
