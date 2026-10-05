import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The tests below read the Chinese strings; the language tests at the end switch it.
const ZH = { options: { language: 'zh' } }

const NOW = Date.parse('2026-10-05T10:00:00+08:00')
const MIN = 60_000
const HOUR = 60 * MIN

// A subscription halfway through a week, two hours into five: one window ahead of pace, one behind.
function fake(on: On) {
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: {
    startedAt: NOW - 2 * HOUR,
    cost: { usd: 3.4123 },
    context: { tokens: 92_000, window: 200_000, percent: 46 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 58, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 31.5, resetsAt: new Date(NOW + 3.5 * 24 * HOUR).toISOString() },
    ],
  } }))
}

// The last request went out 18 minutes ago: 42 minutes of cache left.
function seed(on: On) {
  const mark = { startedAt: NOW - 18 * MIN, ttlMs: HOUR, tokens: 85_000 }
  on('state.get', (($: unknown, e: { key: string }, next: (e: unknown) => unknown) =>
    e.key === 'last' ? { value: { value: mark, version: 1 } } : next(e)) as never)
}

describe('pane', () => {
  for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
    for (const bodyColumns of [36, 52, 100]) {
      test(`${surface} at ${bodyColumns} columns`, ZH, async ($, on) => {
        fake(on)
        seed(on)
        const ui = await $.ui.mount({
          plugin: 'claude-band',
          surface,
          component: 'Pane',
          requestId: 'claude-band',
          props: { title: '缓存钟', isFocused: false, bodyColumns, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
        })
        if (surface === 'terminal') {
          expect(await ui.find({ text: /42分/ })).toBeDefined()
        } else {
          expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(2)
        }
      })
    }
  }
})

describe('band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [60, 90, 140]) {
      test(`${surface} at ${bodyColumns} columns`, ZH, async ($, on) => {
        fake(on)
        seed(on)
        const ui = await $.ui.mount({
          plugin: 'claude-band',
          surface,
          component: 'AbovePrompt',
          props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} } as never,
        })
        if (surface === 'terminal') {
          expect(await ui.find({ text: /58%/ })).toBeDefined()
        } else {
          // a ring and a figure a gauge, a label button between them
          expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(6)
          expect(await ui.find({ key: 'cache' })).toBeDefined()
        }
      })
    }
  }
})

test('/cb text answers with the gauges as text', ZH, async ($, on) => {
  fake(on)
  seed(on)
  const out = await $.command.run({ command: 'cb', args: 'text' } as never)
  expect(JSON.stringify(out)).toContain('5 小时')
})

describe('edge states', () => {
  const cases = {
    'before the first request, off a subscription': { mark: null, limits: false },
    'cache cold': { mark: { startedAt: NOW - 70 * MIN, ttlMs: HOUR, tokens: 120_000 }, limits: true },
    'last minutes': { mark: { startedAt: NOW - 57 * MIN - 9_000, ttlMs: HOUR, tokens: 85_000 }, limits: true },
  }
  for (const [name, c] of Object.entries(cases)) {
    for (const surface of ['terminal', 'mobile'] as const) {
      test(`${name} on ${surface}`, ZH, async ($, on) => {
        on('clock.now', () => ({ value: NOW }))
        on('session.model', () => ({ value: 'claude-opus-5-5' }))
        on('session.usage', () => ({
          value: {
            startedAt: NOW,
            context: c.limits ? { tokens: 180_000, window: 200_000, percent: 90 } : { window: 200_000 },
            rateLimits: c.limits
              ? [
                  { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 4.5 * HOUR).toISOString() },
                  { kind: 'seven_day', percentUsed: 97, resetsAt: new Date(NOW + 20 * HOUR).toISOString() },
                ]
              : [],
          },
        }))
        on('state.get', (($: unknown, e: { key: string }, next: (e: unknown) => unknown) =>
          e.key === 'last' ? { value: { value: c.mark ?? undefined, version: 1 } } : next(e)) as never)
        const ui = await $.ui.mount({
          plugin: 'claude-band',
          surface,
          component: 'Pane',
          requestId: 'claude-band',
          props: { title: '缓存钟', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
        })
        expect(await ui.find({ text: /缓存/ })).toBeDefined()
      })
    }
  }
})

describe('spending', () => {
  const band = (bodyColumns: number) =>
    ({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} }) as never

  // 85k tokens read from a warm Opus 5.5 cache at $0.20/M: about two cents.
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band on ${surface}: on the line when wide, gone when narrow, always once opened`, ZH, async ($, on) => {
      fake(on)
      seed(on)
      const wide = await $.ui.mount({ plugin: 'claude-band', surface, component: 'AbovePrompt', props: band(200) })
      const has = async (ui: typeof wide) =>
        surface === 'terminal'
          ? (await ui.find({ text: /预计 \$0\.02 · 用量 0 · 花费 \$3\.41/ })) !== undefined
          : (await ui.findAll({ type: 'Svg' })).length === 9
      expect(await has(wide)).toBe(true)

      const narrow = await $.ui.mount({ plugin: 'claude-band', surface, component: 'AbovePrompt', props: band(90) })
      expect(await has(narrow)).toBe(false)
      await narrow.press({ key: 'five' })
      if (surface === 'terminal') expect(await narrow.find({ text: /下条预计/ })).toBeDefined()
    })
  }

  // Measured on the desktop: a 95-column band is about 890 px wide, room enough for the group.
  test('band on desktop at 95 columns keeps the group on the line', ZH, async ($, on) => {
    fake(on)
    seed(on)
    const ui = await $.ui.mount({ plugin: 'claude-band', surface: 'desktop', component: 'AbovePrompt', props: band(95) })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(9)
  })

  test('pane shows the group on every surface', ZH, async ($, on) => {
    fake(on)
    seed(on)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'claude-band',
        surface,
        component: 'Pane',
        requestId: 'claude-band',
        props: { title: '缓存钟', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
      })
      expect(await ui.find({ text: /下条预计 \$0\.02 · 会话用量 0 · 会话花费 \$3\.41/ })).toBeDefined()
    }
  })

  test('a cold cache prices the next message as a fresh 1-hour write', ZH, async ($, on) => {
    fake(on)
    // 120k tokens written at 2x Opus 5.5's $4/M input: $0.96.
    const mark = { startedAt: NOW - 70 * MIN, ttlMs: HOUR, tokens: 120_000 }
    on('state.get', (($: unknown, e: { key: string }, next: (e: unknown) => unknown) =>
      e.key === 'last' ? { value: { value: mark, version: 1 } } : next(e)) as never)
    const ui = await $.ui.mount({
      plugin: 'claude-band',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'claude-band',
      props: { title: '缓存钟', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
    })
    expect(await ui.find({ text: /下条预计 \$0\.96/ })).toBeDefined()
  })
})

describe('toggle', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band on ${surface}: a label opens its gauge beneath the line`, ZH, async ($, on) => {
      fake(on)
      seed(on)
      const ui = await $.ui.mount({
        plugin: 'claude-band',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} } as never,
      })
      const svgs = (await ui.findAll({ type: 'Svg' })).length
      expect((await ui.find({ key: 'five' }))?.text).toBe('5 小时')

      await ui.press({ key: 'cache' })
      await ui.press({ key: 'five' })
      if (surface === 'terminal') {
        expect(await ui.find({ text: /缓存剩余/ })).toBeDefined()
        expect(await ui.find({ text: /预期 40%/ })).toBeDefined()
        expect(await ui.find({ text: /5 小时已用/ })).toBeDefined()
      } else {
        const rows = await ui.findAll({ type: 'Svg' })
        expect(rows).toHaveLength(svgs + 1)
      }

      await ui.press({ key: 'cache' })
      await ui.press({ key: 'five' })
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(svgs)
      expect(await ui.find({ text: /剩余|已用/ })).toBeUndefined()
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band on ${surface}: 展开 opens all four, 收起 closes them`, ZH, async ($, on) => {
      fake(on)
      seed(on)
      const ui = await $.ui.mount({
        plugin: 'claude-band',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} } as never,
      })
      expect((await ui.find({ key: 'all' }))?.text).toBe('展开')
      await ui.press({ key: 'all' })
      expect((await ui.find({ key: 'all' }))?.text).toBe('收起')
      if (surface === 'terminal') expect(await ui.find({ text: /上下文已用/ })).toBeDefined()
      await ui.press({ key: 'all' })
      expect((await ui.find({ key: 'all' }))?.text).toBe('展开')
      expect(await ui.find({ text: /剩余|已用/ })).toBeUndefined()

      // One row open, or a single label pressed after 收起: 收起 closes it too.
      await ui.press({ key: 'five' })
      expect((await ui.find({ key: 'all' }))?.text).toBe('收起')
    })
  }

  test('band on desktop: the rule keeps one width whichever rows are open', ZH, async ($, on) => {
    fake(on)
    seed(on)
    const ui = await $.ui.mount({
      plugin: 'claude-band',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} } as never,
    })
    const ruleWidth = async () => {
      const svgs = await ui.findAll({ type: 'Svg' })
      return (svgs[svgs.length - 1] as unknown as { props: { width: number } }).props.width
    }
    await ui.press({ key: 'five' })
    const one = await ruleWidth()
    await ui.press({ key: 'week' })
    await ui.press({ key: 'ctx' })
    expect(await ruleWidth()).toBe(one)
  })

  for (const surface of ['desktop', 'mobile'] as const) {
    test(`pane on ${surface}: 条形 draws one bar a gauge`, ZH, async ($, on) => {
      fake(on)
      seed(on)
      const ui = await $.ui.mount({
        plugin: 'claude-band',
        surface,
        component: 'Pane',
        requestId: 'claude-band',
        props: { title: '缓存钟', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
      })
      await ui.press({ key: 'bar' })
      const bars = await ui.findAll({ type: 'Svg' })
      expect(bars).toHaveLength(4)
      await ui.press({ key: 'ring' })
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
    })
  }
})

test('finished turns add up into the session total, subagents included', ZH, async ($, on) => {
  fake(on)
  on('turn.complete', (() => ({ text: '' })) as never)
  const usage = (n: number, model: string) => ({
    input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n, model,
  })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(250_000, 'claude-opus-5-5') } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer', usage: usage(50_000, 'claude-haiku-4-5') } as never)
  const ui = await $.ui.mount({
    plugin: 'claude-band',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'claude-band',
    props: { title: '缓存钟', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never,
  })
  // 4 x 250k + 4 x 50k = 1.2M. Nothing cached yet, so the next message writes the 92k context
  // at 2x the main loop's Opus 5.5 input ($4/M): $0.74, not the subagent's Haiku price.
  expect(await ui.find({ text: /下条预计 \$0\.74 · 会话用量 1\.2M/ })).toBeDefined()
})

describe('language', () => {
  const pane = { title: 'x', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never

  test('en draws English everywhere', { options: { language: 'en' } }, async ($, on) => {
    fake(on)
    seed(on)
    const ui = await $.ui.mount({ plugin: 'claude-band', surface: 'terminal', component: 'Pane', requestId: 'claude-band', props: pane })
    expect(await ui.find({ text: /Weekly/ })).toBeDefined()
    expect(await ui.find({ text: /actual 58% · expected 40% · 18% ahead/ })).toBeDefined()
    expect(await ui.find({ text: /Next message \$0\.02 · Session tokens 0 · Session cost \$3\.41/ })).toBeDefined()
    expect(await ui.find({ text: /[\u4e00-\u9fff]/ })).toBeUndefined()

    const band = await $.ui.mount({
      plugin: 'claude-band', surface: 'desktop', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { top: 0, bodyRows: 10, contentRows: 0 }, view: {} } as never,
    })
    expect((await band.find({ key: 'all' }))?.text).toBe('Expand')
    expect((await band.find({ key: 'five' }))?.text).toBe('5h')
  })

  for (const [name, setting, lang, expected] of [
    ['Claude Code set to Chinese', '简体中文', undefined, '周限'],
    ['a zh_CN locale', undefined, 'zh_CN.UTF-8', '周限'],
    ['an English locale', undefined, 'en_US.UTF-8', 'Weekly'],
    ['nothing to go on (Chinese)', undefined, undefined, '周限'],
  ] as const) {
    test(`auto follows ${name}`, async ($, on) => {
      fake(on)
      seed(on)
      on('settings.read', () => ({ value: setting === undefined ? {} : { language: setting } }) as never)
      on('env.get', (($: unknown, e: { name: string }) => ({ value: e.name === 'LANG' ? lang : undefined })) as never)
      on('command.register', () => ({ value: {} }) as never)
      on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
      on('session.start', ((_: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
      await $.session.start({ cwd: '/' } as never)
      const ui = await $.ui.mount({ plugin: 'claude-band', surface: 'terminal', component: 'Pane', requestId: 'claude-band', props: pane })
      expect(await ui.find({ text: new RegExp(expected) })).toBeDefined()
    })
  }
})

describe('commands', () => {
  test('on the desktop or terminal /cb opens the pane and says so, nothing more', ZH, async ($, on) => {
    fake(on)
    seed(on)
    const opens: unknown[] = []
    on('ui.open', (($: unknown, e: unknown) => (opens.push(e), { value: {} })) as never)
    const short = JSON.stringify(await $.command.run({ command: 'cb', args: '' } as never))
    const full = JSON.stringify(await $.command.run({ command: 'claude-band', args: '' } as never))
    expect(short).toContain('已打开 ClaudeBand 面板，用 /cb lang <语言> 切换语言')
    expect(short).not.toContain('周限')
    expect(full).toBe(short)
    expect(opens).toHaveLength(2)
  })

  // The phone's /cb (origin `bridge`, which a test cannot stamp) answers what /cb text does.
  test('/cb text answers with the clock in plain lines, no pane', ZH, async ($, on) => {
    fake(on)
    seed(on)
    const opens: unknown[] = []
    on('ui.open', (($: unknown, e: unknown) => (opens.push(e), { value: {} })) as never)
    const out = (await $.command.run({ command: 'cb', args: 'text' } as never)) as { text: string }
    expect(out.text.split('\n')).toEqual([
      '缓存剩余 42 分（10:42 到期）',
      '5 小时已用 58%，预期 40%（3时后重置）',
      '周限已用 32%，预期 50%（3天12时后重置）',
      '上下文已用 46%（92k/200k）',
      '下条预计 $0.02 · 会话用量 0 · 会话花费 $3.41',
    ])
    expect(opens).toHaveLength(0)
  })

  test('/cb lang en stores the option and answers in English', ZH, async ($, on) => {
    fake(on)
    const writes: unknown[] = []
    on('config.set', (($: unknown, e: { key: string; value: unknown }) => {
      writes.push([e.key, e.value])
      return { value: e.value }
    }) as never)
    const out = JSON.stringify(await $.command.run({ command: 'cb', args: 'lang en' } as never))
    expect(writes).toEqual([['claude-band.language', 'en']])
    expect(out).toContain('Language set to English')
  })

  test('/cb lang with no code shows the choices; an unknown code is refused', ZH, async ($, on) => {
    fake(on)
    const now = JSON.stringify(await $.command.run({ command: 'cb', args: 'lang' } as never))
    expect(now).toContain('当前语言：简体中文')
    expect(now).toContain('auto | zh | en')
    const bad = JSON.stringify(await $.command.run({ command: 'cb', args: 'lang xx' } as never))
    expect(bad).toContain('没有「xx」这种语言')
  })
})

test('every language file fills the whole contract', async () => {
  const { LOCALES } = await import('../hooks/locales')
  const keys = Object.keys(LOCALES['en']!).sort()
  for (const locale of Object.values(LOCALES)) expect(Object.keys(locale).sort()).toEqual(keys)
})

describe('warning levels', () => {
  const DAY = 24 * HOUR
  // The colour the terminal pane draws a figure in: green, yellow, red.
  const colourOf = async (ui: { drawn: () => Promise<unknown> }, figure: string) => {
    const walk = (node: unknown): string | undefined => {
      if (node === null || typeof node !== 'object') return undefined
      const n = node as { type?: string; props?: { color?: string; children?: unknown }; children?: unknown }
      const kids = n.children ?? n.props?.children
      if (n.type === 'Text' && JSON.stringify(kids) === JSON.stringify([figure])) return n.props?.color ?? 'none'
      for (const kid of Array.isArray(kids) ? kids : [kids]) {
        const found = walk(kid)
        if (found) return found
      }
      return undefined
    }
    return walk(await ui.drawn())
  }
  const pane = { title: 'x', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { top: 0, bodyRows: 30, contentRows: 0 }, view: {} } as never
  const usage = (weekly: number, weekLeftDays: number, context: number) => (on: On) => {
    on('clock.now', () => ({ value: NOW }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({
      value: {
        startedAt: NOW,
        context: { tokens: context * 2000, window: 200_000, percent: context },
        rateLimits: [{ kind: 'seven_day', percentUsed: weekly, resetsAt: new Date(NOW + weekLeftDays * DAY).toISOString() }],
      },
    }))
  }

  for (const [name, weekly, weekLeft, context, expectWeekly, expectContext] of [
    ['early in the week, 10% used (tick at 4%)', 10, 6.72, 64, 'green', 'green'],
    ['early in the week, 15% used (11 points ahead)', 15, 6.72, 80, 'yellow', 'yellow'],
    ['85% used, on pace', 85, 0.5, 92, 'yellow', 'red'],
    ['91% used', 91, 0.2, 50, 'red', 'green'],
  ] as const) {
    test(name, ZH, async ($, on) => {
      usage(weekly, weekLeft, context)(on)
      seed(on)
      const ui = await $.ui.mount({ plugin: 'claude-band', surface: 'terminal', component: 'Pane', requestId: 'claude-band', props: pane })
      expect(await colourOf(ui, `${weekly}%`)).toBe(expectWeekly)
      expect(await colourOf(ui, `${context}%`)).toBe(expectContext)
    })
  }

  test('levels come from the config', { options: { language: 'zh', warnAt: 50, alertAt: 60, paceMargin: 0 } }, async ($, on) => {
    usage(15, 6.72, 64)(on)
    seed(on)
    const ui = await $.ui.mount({ plugin: 'claude-band', surface: 'terminal', component: 'Pane', requestId: 'claude-band', props: pane })
    expect(await colourOf(ui, '15%')).toBe('green') // the pace rule is off
    expect(await colourOf(ui, '64%')).toBe('red') // past 60
  })
})
