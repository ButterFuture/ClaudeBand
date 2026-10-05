import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { CacheMark, GaugeId, GaugeView, Spent } from '../types'
import { FALLBACK, LOCALES, matchLocale } from './locales'
import type { Locale } from './locales'

const PANE = 'claude-band'
// The command, in full and short.
const COMMANDS = ['claude-band', 'cb'] as const
const DEFAULT_TTL_MS = 60 * 60 * 1000
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const last = atom({ plugin: 'claude-band', key: 'last' } as const, null)
// Which gauges the band has opened beneath its line, in the line's order.
const bandOpen = atom({ plugin: 'claude-band', key: 'bandOpen' } as const, [] as GaugeId[])
const paneView = atom({ plugin: 'claude-band', key: 'paneView' } as const, 'ring' as GaugeView)
const spent = atom({ plugin: 'claude-band', key: 'spent' } as const, { tokens: 0, model: null } as Spent)
const ORDER: GaugeId[] = ['cache', 'five', 'week', 'ctx']
const toggleOpen = (id: GaugeId) => (open: GaugeId[]) =>
  open.includes(id) ? open.filter(one => one !== id) : ORDER.filter(one => one === id || open.includes(one))

// ---------------------------------------------------------------------------
// Words: every string the plugin draws comes from the language files in ./locales.

// The language drawn now: the `language` option pins one; `auto` (the default) is resolved
// at session start (see `resolveLocale`). Module state: a reload resolves it again.
let t: Locale = FALLBACK

// `auto`: Claude Code's own `language` setting first, then the locale variables; Chinese
// when nothing says.
async function resolveLocale($: EngineInterface): Promise<Locale> {
  const settings = await $.settings.read()
  return (
    matchLocale(settings['language']) ??
    matchLocale(await $.env.get('LC_ALL')) ??
    matchLocale(await $.env.get('LC_MESSAGES')) ??
    matchLocale(await $.env.get('LANG')) ??
    FALLBACK
  )
}

// ---------------------------------------------------------------------------
// Warning levels, from the plugin's options (/config): percent used at which 5h, weekly
// and context turn yellow and red, and how many points ahead of the pace tick a window may
// run before it turns yellow early (0: never). A window's start is no cause on its own:
// 10% used with the tick at 4% is 6 points ahead, which is not enough.
type Levels = { warnAt: number; alertAt: number; paceMargin: number }

const DEFAULT_LEVELS: Levels = { warnAt: 80, alertAt: 90, paceMargin: 10 }

let levels: Levels = DEFAULT_LEVELS

function levelsFrom(options: Readonly<Record<string, unknown>>): Levels {
  const num = (key: keyof Levels) => {
    const value = Number(options[key])
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_LEVELS[key]
  }
  const warnAt = num('warnAt')
  // Red is never below yellow.
  return { warnAt, alertAt: Math.max(warnAt, num('alertAt')), paceMargin: num('paceMargin') }
}

// ---------------------------------------------------------------------------
// The four gauges, worked out once and drawn by every surface.

type Tone = 'ok' | 'warn' | 'bad' | 'idle'

type Gauge = {
  id: GaugeId
  label: string
  /** 0..1: how much of the ring is drawn in the tone colour */
  fill: number
  /** 0..1: where spending evenly over the window would be by now (the tick); absent, no tick */
  pace?: number
  tone: Tone
  /** the big figure in the middle of the ring */
  value: string
  /** the small line under it */
  sub: string
  /** a line under the ring */
  note: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const hhmmss = (ms: number) => `${hhmm(ms)}:${pad(new Date(ms).getSeconds())}`
const kTokens = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`

// 2天3时 / 3时12分 / 12分
function span(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / MIN))
  if (m >= 24 * 60) return t.span(Math.floor(m / 1440), Math.floor((m % 1440) / 60), 0)
  return t.span(0, Math.floor(m / 60), m % 60)
}

function cacheGauge(mark: CacheMark | null, now: number): Gauge {
  const base = { id: 'cache', label: t.labels.cache } as const
  if (mark === null) {
    return { ...base, fill: 0, tone: 'idle', value: '—', sub: t.waiting, note: t.startsNext }
  }

  const left = mark.startedAt + mark.ttlMs - now
  if (left <= 0) {
    return {
      ...base,
      fill: 0,
      tone: 'idle',
      value: t.expired,
      sub: t.expiredAt(hhmm(mark.startedAt + mark.ttlMs)),
      note: t.recache(kTokens(mark.tokens)),
    }
  }

  // Under 5 minutes the seconds count; before that whole minutes do.
  const s = Math.ceil(left / 1000)
  return {
    ...base,
    fill: left / mark.ttlMs,
    tone: left > 10 * MIN ? 'ok' : left > 5 * MIN ? 'warn' : 'bad',
    value: left < 5 * MIN ? `${Math.floor(s / 60)}:${pad(s % 60)}` : t.minutes(Math.ceil(left / MIN)),
    sub: t.until(hhmm(mark.startedAt + mark.ttlMs)),
    note: mark.tokens > 0 ? t.cached(kTokens(mark.tokens)) : t.left(span(left)),
  }
}

// A rate-limit window: the fill is what is used, the tick how much of the window has gone by.
function limitGauge(
  id: 'five' | 'week',
  label: string,
  limit: SessionRateLimit | undefined,
  windowMs: number,
  now: number,
): Gauge {
  if (limit === undefined) {
    return { id, label, fill: 0, tone: 'idle', value: '—', sub: t.noReading, note: t.nextReply }
  }

  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (!Number.isNaN(resetsAt) && resetsAt <= now) {
    // The reading is from a window that has already rolled over.
    return { id, label, fill: 0, pace: 0, tone: 'ok', value: '0%', sub: t.reset, note: t.resetAt(hhmm(resetsAt)) }
  }

  const used = clamp01(limit.percentUsed / 100)
  const pace = Number.isNaN(resetsAt) ? undefined : clamp01(1 - (resetsAt - now) / windowMs)
  const ahead = pace === undefined ? 0 : used - pace
  const tone: Tone =
    used * 100 >= levels.alertAt
      ? 'bad'
      : used * 100 >= levels.warnAt || (levels.paceMargin > 0 && ahead * 100 >= levels.paceMargin)
        ? 'warn'
        : 'ok'

  return {
    id,
    label,
    fill: used,
    ...(pace === undefined ? {} : { pace }),
    tone,
    value: `${Math.round(limit.percentUsed)}%`,
    sub: pace === undefined ? t.used : t.expect(Math.round(pace * 100)),
    note: Number.isNaN(resetsAt) ? '' : t.resetsIn(span(resetsAt - now)),
  }
}

function contextGauge(usage: SessionUsage): Gauge {
  const { tokens, window, percent } = usage.context
  const base = { id: 'ctx', label: t.labels.ctx } as const
  const p = percent ?? (tokens !== undefined && window > 0 ? (tokens / window) * 100 : undefined)
  if (p === undefined) {
    return { ...base, fill: 0, tone: 'idle', value: '—', sub: t.noReading, note: t.window(kTokens(window)) }
  }

  return {
    ...base,
    fill: clamp01(p / 100),
    tone: p >= levels.alertAt ? 'bad' : p >= levels.warnAt ? 'warn' : 'ok',
    value: `${Math.round(p)}%`,
    sub: tokens === undefined ? t.used : `${kTokens(tokens)}/${kTokens(window)}`,
    note: t.window(kTokens(window)),
  }
}

async function measure($: EngineInterface): Promise<Gauge[]> {
  const mark = await read($, last)
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const limit = (kind: string) => usage.rateLimits.find(one => one.kind === kind)

  return [
    cacheGauge(mark, now),
    limitGauge('five', t.labels.five, limit('five_hour'), 5 * HOUR, now),
    limitGauge('week', t.labels.week, limit('seven_day'), 7 * DAY, now),
    contextGauge(usage),
  ]
}

// A window's actual use against its pace, spelled out; any other gauge, its small line.
function detail(g: Gauge): string {
  if (g.pace === undefined || g.tone === 'idle') return g.sub
  const used = Math.round(g.fill * 100)
  const pace = Math.round(g.pace * 100)
  const gap = used - pace
  return t.detail(used, pace, gap)
}

// ---------------------------------------------------------------------------
// Spending: what the next message is expected to cost, and the session so far.

// List prices per million tokens: base input and cache read. A cache write costs
// 1.25x input on the 5-minute tier and 2x on the 1-hour one. Longer ids first, so
// `opus-5-5` is not taken for `opus-5`.
const PRICES: [string, { input: number; read: number }][] = [
  ['fable-5-1', { input: 10, read: 0.25 }],
  ['mythos-5-1', { input: 10, read: 0.25 }],
  ['fable-5', { input: 10, read: 1 }],
  ['mythos-5', { input: 10, read: 1 }],
  ['opus-5-5', { input: 4, read: 0.2 }],
  ['opus-5', { input: 5, read: 0.5 }],
  ['opus-4-8', { input: 5, read: 0.5 }],
  ['opus-4-7', { input: 5, read: 0.5 }],
  ['opus-4-6', { input: 5, read: 0.5 }],
  ['sonnet-5-5', { input: 2, read: 0.2 }],
  ['sonnet-5', { input: 2, read: 0.2 }],
  ['sonnet-4-6', { input: 3, read: 0.3 }],
  ['haiku-4-5', { input: 1, read: 0.1 }],
]

type Spend = {
  /** dollars the next message's prompt should cost: read from a warm cache, else written anew; absent for an unpriced model */
  next?: number
  /** session tokens so far */
  tokens: number
  /** session dollars so far, as /cost totals them */
  usd?: number
}

async function spending($: EngineInterface, cache: Gauge): Promise<Spend> {
  const mark = await read($, last)
  const { tokens, model } = await read($, spent)
  const usage = await $.session.usage()
  const id = model ?? (await $.session.model())
  const price = PRICES.find(([key]) => id.includes(key))?.[1]
  const context = mark?.tokens || usage.context.tokens || 0
  const ttlMs = mark?.ttlMs ?? DEFAULT_TTL_MS
  // Warm: the prompt is read from the cache. Cold (or never cached): written to it again.
  const perM =
    price === undefined ? undefined : cache.tone !== 'idle' ? price.read : price.input * (ttlMs > 5 * MIN ? 2 : 1.25)
  return {
    ...(perM === undefined || context === 0 ? {} : { next: (context * perM) / 1e6 }),
    tokens,
    ...(usage.cost === undefined ? {} : { usd: usage.cost.usd }),
  }
}

const money = (usd: number) =>
  usd < 0.01 ? '<$0.01' : `$${usd >= 100 ? usd.toFixed(0) : usd >= 10 ? usd.toFixed(1) : usd.toFixed(2)}`

// 下条预计 $0.02 · 会话用量 1.2M · 会话花费 $3.41; on the band's collapsed line, where
// room is short, the brief form: 预计 $0.02 · 用量 1.2M · 花费 $3.41.
const spendText = (sp: Spend, isBrief = false) =>
  [
    `${(isBrief ? t.spendBrief : t.spend).next} ${sp.next === undefined ? '—' : money(sp.next)}`,
    `${(isBrief ? t.spendBrief : t.spend).tokens} ${sp.tokens === 0 ? '0' : kTokens(sp.tokens)}`,
    ...(sp.usd === undefined ? [] : [`${(isBrief ? t.spendBrief : t.spend).cost} ${money(sp.usd)}`]),
  ].join(' · ')

// The band's opened row: the cache speaks in time left, its bar draining; the windows and
// the context in what is used, their bars filling from zero as on the line above, with the
// share the pace expects by now.
type Opened = { lead: string; value: string; rest: string; note: string; gauge: Gauge }

function opened(g: Gauge): Opened {
  if (g.tone === 'idle' && g.id !== 'cache') {
    return { lead: `${g.label} `, value: '', rest: g.sub, note: g.note, gauge: g }
  }
  switch (g.id) {
    case 'cache':
      return g.tone === 'idle'
        ? { lead: `${g.label} `, value: '', rest: g.value === t.expired ? t.expired : t.waiting, note: g.note, gauge: g }
        : { lead: t.cacheLeft, value: t.spaced(g.value), rest: '', note: g.sub, gauge: g }
    case 'ctx':
      return { lead: t.usedLead(g.label), value: g.value, rest: '', note: g.sub, gauge: g }
    default:
      return {
        lead: t.usedLead(g.label),
        value: g.value,
        rest: g.pace === undefined ? '' : t.expectRest(Math.round(g.pace * 100)),
        note: g.note,
        gauge: g,
      }
  }
}

// One gauge as a plain sentence, for /cb on the phone: 5 小时已用 15%，预期 48%（2时36分后重置）
const summaryLine = (o: Opened) => `${o.lead}${o.value}${o.rest}`.trim() + (o.note ? t.aside(o.note) : '')

// ---------------------------------------------------------------------------
// Text: the terminal, and the command's answer.

type Run = { text: string; tone?: Tone; tick?: boolean; dim?: boolean; bold?: boolean; press?: GaugeId }

const TERM_COLOR: Record<Tone, string | undefined> = { ok: 'green', warn: 'yellow', bad: 'red', idle: undefined }

// Terminal cells a string takes: CJK and full-width forms take two.
const cells = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
const padCells = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - cells(s)))
const width = (runs: Run[]) => runs.reduce((n, r) => n + cells(r.text), 0)

// ━━━━━┃━━───── : the fill in the tone colour, the rest dim, the tick where the pace is.
function bar(g: Gauge, w: number): Run[] {
  const filled = Math.round(g.fill * w)
  const tick = g.pace === undefined ? -1 : Math.min(w - 1, Math.floor(g.pace * w))
  const runs: Run[] = []
  for (let i = 0; i < w; i += 1) {
    const run: Run =
      i === tick ? { text: '┃', tick: true, bold: true } : i < filled ? { text: '━', tone: g.tone } : { text: '─', dim: true }
    const prev = runs[runs.length - 1]
    if (prev && !run.tick && !prev.tick && prev.tone === run.tone && prev.dim === run.dim) prev.text += run.text
    else runs.push(run)
  }
  return runs
}

const dot = (g: Gauge): Run => ({ text: g.tone === 'idle' ? '○ ' : '● ', tone: g.tone })

// The band: one line, as much of it as the width allows.
function bandLine(gs: Gauge[], columns: number, open: GaugeId[]): Run[] {
  const [cache, five, week, ctx] = gs as [Gauge, Gauge, Gauge, Gauge]
  const sep: Run = { text: ' │ ', dim: true }
  const build = (barW: number, withCtx: boolean, withExpiry: boolean): Run[] => {
    // Each label is the button that opens its gauge beneath the line.
    const label = (g: Gauge): Run[] => [{ text: g.label, press: g.id, dim: !open.includes(g.id) }, { text: ' ' }]
    const limit = (g: Gauge): Run[] => [
      ...label(g),
      ...(barW > 0 ? [...bar(g, barW), { text: ' ' }] : []),
      { text: g.value, tone: g.tone, bold: true },
    ]
    return [
      dot(cache),
      ...label(cache),
      { text: cache.value, tone: cache.tone, bold: true },
      ...(withExpiry && cache.tone !== 'idle' ? [{ text: ` ${cache.sub}`, dim: true }] : []),
      sep,
      ...limit(five),
      sep,
      ...limit(week),
      ...(withCtx ? [sep, ...label(ctx), { text: ctx.value, tone: ctx.tone, bold: true }] : []),
    ]
  }

  for (const [withCtx, withExpiry] of [[true, true], [true, false], [false, false]] as const) {
    const room = columns - 1 - width(build(0, withCtx, withExpiry))
    const barW = Math.min(16, Math.floor((room - 2) / 2))
    if (barW >= 4) return build(barW, withCtx, withExpiry)
  }
  return build(0, false, false)
}

// The band's opened rows on the terminal: what is left, then a bar, then when it ends.
function openedLines(gs: Gauge[], open: GaugeId[], columns: number, sp: Spend): Run[][] {
  const rows = gs.filter(g => open.includes(g.id)).map(opened)
  const textW = Math.max(...rows.map(o => cells(o.lead + o.value + o.rest))) + 2
  const noteW = Math.max(...rows.map(o => cells(o.note)))
  const barW = Math.max(6, Math.min(24, columns - textW - noteW - 2))
  return rows.map(o => [
    { text: o.lead, dim: true },
    { text: o.value, tone: o.gauge.tone, bold: true },
    { text: padCells(o.rest, textW - cells(o.lead + o.value)), dim: true },
    ...bar(o.gauge, barW),
    { text: ` ${o.note}`, dim: true },
  ]).concat([[{ text: spendText(sp), dim: true }]])
}

// The pane and the command: two lines a gauge, the bar and then what it means.
function blockLines(gs: Gauge[], columns: number): Run[][] {
  const labelW = Math.max(...gs.map(g => cells(g.label))) + 1
  const barW = Math.max(6, Math.min(32, columns - 2 - labelW - 8))
  return gs.flatMap(g => [
    [
      dot(g),
      { text: padCells(g.label, labelW), bold: true },
      ...bar(g, barW),
      { text: ' ' },
      { text: g.value, tone: g.tone, bold: true },
    ],
    [{ text: ' '.repeat(2 + labelW) }, { text: [detail(g), g.note].filter(Boolean).join(' · '), dim: true }],
  ])
}


// ---------------------------------------------------------------------------
// Rings: the desktop, the phone and the editor draw SVG.

const HEX: Record<Tone, string> = { ok: '#16a34a', warn: '#d97706', bad: '#dc2626', idle: '#9ca3af' }
const HEX_DARK: Record<Tone, string> = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', idle: '#6b7280' }
const SUB = '#7c818b'
const FONT = `system-ui,-apple-system,'Segoe UI','PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif`

// The colours are attributes, so the drawing holds without the style; the style only
// brightens them on a dark page and keeps the ticking figures from jittering.
const STYLE =
  `<style>text{font-family:${FONT};font-variant-numeric:tabular-nums}` +
  `@media (prefers-color-scheme:dark){` +
  (Object.keys(HEX) as Tone[]).map(t => `.s-${t}{stroke:${HEX_DARK[t]}}.f-${t}{fill:${HEX_DARK[t]}}`).join('') +
  `.sub{fill:#9ca3af}}</style>`

const f1 = (n: number) => +n.toFixed(1)

// The tick: a light line in a dark casing, so it shows on a light page and a dark one alike.
function tickSvg(cx: number, cy: number, r: number, sw: number, pace: number, over = 3): string {
  const a = pace * 2 * Math.PI - Math.PI / 2
  const r0 = r - sw / 2 - over
  const r1 = r + sw / 2 + over
  const xy = `x1="${f1(cx + r0 * Math.cos(a))}" y1="${f1(cy + r0 * Math.sin(a))}" x2="${f1(cx + r1 * Math.cos(a))}" y2="${f1(cy + r1 * Math.sin(a))}"`
  return (
    `<line ${xy} stroke="#111827" stroke-opacity="0.75" stroke-width="${f1(Math.max(over + 1, sw * 0.42))}" stroke-linecap="round"/>` +
    `<line ${xy} stroke="#ffffff" stroke-width="${f1(Math.max(over / 2 + 0.5, sw * 0.18))}" stroke-linecap="round"/>`
  )
}

function arcSvg(cx: number, cy: number, r: number, sw: number, g: Gauge): string {
  const len = 2 * Math.PI * r
  const track = `<circle cx="${cx}" cy="${cy}" r="${f1(r)}" fill="none" stroke="#808080" stroke-opacity="0.22" stroke-width="${sw}"/>`
  if (g.fill <= 0) return track
  return (
    track +
    `<circle class="s-${g.tone}" cx="${cx}" cy="${cy}" r="${f1(r)}" fill="none" stroke="${HEX[g.tone]}" stroke-width="${sw}"` +
    ` stroke-linecap="round" stroke-dasharray="${f1(g.fill * len)} ${f1(len)}" transform="rotate(-90 ${cx} ${cy})"/>`
  )
}

function ringSvg(g: Gauge, size: number): string {
  const sw = Math.max(6, Math.round(size * 0.095))
  const c = size / 2
  const r = c - sw / 2 - 4
  // Both lines fit inside the ring, however long a language's words run.
  const inner = 2 * (r - sw / 2) - 8
  const valueSize = Math.round(Math.min(size * 0.23, (inner * 0.95) / textW(g.value, 1, true)))
  const subSize = Math.max(8, Math.round(Math.min(size * 0.105, (inner * 0.85) / textW(g.sub, 1))))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    STYLE +
    arcSvg(c, c, r, sw, g) +
    (g.pace === undefined ? '' : tickSvg(c, c, r, sw, g.pace)) +
    `<text class="f-${g.tone}" x="${c}" y="${f1(c + valueSize * 0.3)}" text-anchor="middle" font-size="${valueSize}" font-weight="700" fill="${HEX[g.tone]}">${g.value}</text>` +
    `<text class="sub" x="${c}" y="${f1(c + valueSize * 0.3 + subSize * 1.45)}" text-anchor="middle" font-size="${subSize}" fill="${SUB}">${g.sub}</text>` +
    `</svg>`
  )
}

// Pixels a string takes at a font size, near enough to lay a strip out (bold digits run wider).
// Wide Latin letters (m, w, M, W) and % run about 0.9em; the rest about 0.6em, a touch
// more in bold. Generous on purpose: the band's room check was calibrated against it.
const charW = (ch: string, isBold: boolean) =>
  cells(ch) === 2 ? 1 : /[mwMW%]/.test(ch) ? 0.9 : isBold ? 0.66 : 0.6
const textW = (s: string, size: number, isBold = false) => [...s].reduce((n, ch) => n + size * charW(ch, isBold), 0)

// A bar's tick: upright, cased like the ring's.
function barTickSvg(x: number, y0: number, y1: number, thin = false): string {
  const xy = `x1="${f1(x)}" y1="${f1(y0)}" x2="${f1(x)}" y2="${f1(y1)}"`
  return (
    `<line ${xy} stroke="#111827" stroke-opacity="0.75" stroke-width="${thin ? 2.6 : 4}" stroke-linecap="round"/>` +
    `<line ${xy} stroke="#ffffff" stroke-width="${thin ? 1.2 : 2}" stroke-linecap="round"/>`
  )
}

function barBodySvg(g: Gauge, x: number, y: number, w: number, h: number, thin = false): string {
  const fill = g.fill > 0 ? Math.max(h, g.fill * w) : 0
  return (
    `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${h}" rx="${h / 2}" fill="#808080" fill-opacity="0.22"/>` +
    (fill > 0
      ? `<rect class="f-${g.tone}" x="${f1(x)}" y="${f1(y)}" width="${f1(fill)}" height="${h}" rx="${h / 2}" fill="${HEX[g.tone]}"/>`
      : '') +
    (g.pace === undefined ? '' : barTickSvg(x + g.pace * w, y - (thin ? 2.5 : 4), y + h + (thin ? 2.5 : 4), thin))
  )
}

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}${body}</svg>`

// The desktop band's line: per gauge a small ring, its label (a button, drawn by the
// surface) and its figure; ring and figure are SVG so the figure keeps tabular digits.
const BAND_H = 18

// The desktop line's spending group: grey, a size below the figures it follows.
function spendSvg(sp: Spend): { source: string; width: number } {
  const text = spendText(sp, true)
  // The surface's sans runs a little wider than the estimate: measured, about 4%.
  const width = Math.ceil(textW(text, 11) * 1.05) + 4
  return {
    source: svgDoc(width, BAND_H, `<text class="sub" x="2" y="${BAND_H / 2 + 4}" font-size="11" fill="${SUB}">${text}</text>`),
    width,
  }
}

function miniRingSvg(g: Gauge): string {
  const ring = 14
  const sw = 2.6
  const c = ring / 2
  const r = c - sw / 2 - 1
  return svgDoc(ring, BAND_H, arcSvg(c, BAND_H / 2, r, sw, g) + (g.pace === undefined ? '' : tickSvg(c, BAND_H / 2, r, sw, g.pace, 1)))
}

function figureSvg(g: Gauge): { source: string; width: number } {
  const width = Math.ceil(textW(g.value, 12, true)) + 2
  return {
    source: svgDoc(width, BAND_H, `<text class="f-${g.tone}" x="1" y="${BAND_H / 2 + 4}" font-size="12" font-weight="700" fill="${HEX[g.tone]}">${g.value}</text>`),
    width,
  }
}

// The band's opened rows on the desktop: a rule under the line, then one row an opened
// gauge (what is left, a bar with the pace's tick, when it ends), the bars in one column.
// The columns are laid out against every gauge, not just the opened ones, so the rule and
// the bars keep one width whichever rows are open; and the rule is at least as long as the
// line above it (estimated: the surface draws the label buttons, the plugin cannot measure them).
function openedSvg(gs: Gauge[], open: GaugeId[], room: number, lineW: number, sp: Spend): { source: string; width: number; height: number } {
  const all = gs.map(opened)
  const rows = gs.filter(g => open.includes(g.id)).map(opened)
  const RULE = 9
  const ROW = 20
  const textEnd = Math.max(...all.map(o => textW(o.lead + o.rest, 12) + textW(o.value, 12, true))) + 10
  const noteW = Math.max(...all.map(o => textW(o.note, 11)))
  const barW = Math.round(Math.max(60, Math.min(180, room - textEnd - noteW - 12)))
  const width = Math.ceil(Math.min(room, Math.max(lineW, textEnd + barW + 8 + noteW + 2)))
  let body = `<line x1="0" y1="4.5" x2="${width}" y2="4.5" stroke="#808080" stroke-opacity="0.35" stroke-width="1"/>`
  rows.forEach((o, i) => {
    const cy = RULE + i * ROW + ROW / 2
    // One text run, the figure a tspan inside it: the surface lays the words out by their
    // real widths, so the figure sits right after its label and the comma right after it.
    body +=
      `<text xml:space="preserve" x="1" y="${cy + 4}" font-size="12">` +
      `<tspan class="sub" fill="${SUB}">${o.lead}</tspan>` +
      (o.value ? `<tspan class="f-${o.gauge.tone}" font-weight="700" fill="${HEX[o.gauge.tone]}">${o.value}</tspan>` : '') +
      (o.rest ? `<tspan class="sub" fill="${SUB}">${o.rest}</tspan>` : '') +
      `</text>`
    body += barBodySvg(o.gauge, textEnd, cy - 3, barW, 6, true)
    body += `<text class="sub" x="${f1(textEnd + barW + 8)}" y="${cy + 4}" font-size="11" fill="${SUB}">${o.note}</text>`
  })
  // The spending line closes the rows, grey and a size smaller.
  const cy = RULE + rows.length * ROW + ROW / 2
  body += `<text class="sub" x="1" y="${cy + 4}" font-size="11" fill="${SUB}">${spendText(sp)}</text>`
  const height = RULE + (rows.length + 1) * ROW
  return { source: svgDoc(width, height, body), width, height }
}

// The pane, as bars: one row a gauge, the label and figure over the bar, actual against
// expected under it; the reset time drops to its own line when the row is too narrow.
function barRowSvg(g: Gauge, w: number): { source: string; height: number } {
  const left = detail(g)
  const fits = textW(left, 12) + 16 + textW(g.note, 12) <= w - 4
  const h = fits || !g.note ? 58 : 74
  return {
    source: svgDoc(
      w,
      h,
      `<text class="sub" x="2" y="15" font-size="13" font-weight="600" fill="${SUB}">${g.label}</text>` +
        `<text class="f-${g.tone}" x="${w - 2}" y="16" text-anchor="end" font-size="16" font-weight="700" fill="${HEX[g.tone]}">${g.value}</text>` +
        barBodySvg(g, 2, 24, w - 4, 10) +
        `<text class="sub" x="2" y="52" font-size="12" fill="${SUB}">${left}</text>` +
        (g.note
          ? fits
            ? `<text class="sub" x="${w - 2}" y="52" text-anchor="end" font-size="12" fill="${SUB}">${g.note}</text>`
            : `<text class="sub" x="2" y="68" font-size="12" fill="${SUB}">${g.note}</text>`
          : ''),
    ),
    height: h,
  }
}

const alt = (g: Gauge) => [g.label, g.value, g.sub, g.note].filter(Boolean).join(' ')

// A remote surface measures its body in cells of its code font. Measured on the desktop
// (a 95-column band about 890 px wide inside its padding): about 9.4 px a cell. The phone's
// font is not measured; its layout was sized for 7.5.
const cellPx = (surface: string) => (surface === 'mobile' ? 7.5 : 9.4)

// ---------------------------------------------------------------------------

// `/cb lang [code]`: with no code, what is set and what can be; with one, store it as the
// plugin's `language` option, written like a /config change, which reloads the plugin.
async function setLanguage($: EngineInterface, code: string | undefined, pinned: Locale | undefined): Promise<string> {
  const choices = ['auto', ...Object.keys(LOCALES)].join(' | ')
  if (code === undefined) return t.langNow(pinned ? pinned.name : `auto (${t.name})`, choices)
  if (code !== 'auto' && !LOCALES[code]) return t.langUnknown(code, choices)

  const { deny } = await $.config.set({ key: 'claude-band.language', value: code })
  if (deny !== undefined) return deny
  t = LOCALES[code] ?? (await resolveLocale($))
  $.ui.invalidate('ui.render')
  return code === 'auto' ? t.langAuto(t.name) : t.langSet(t.name)
}

export const register: Register = (on, options) => {
  let tick = 0
  // The `language` option pins a language; `auto` (the default) is resolved at session start.
  levels = levelsFrom(options)
  const choice = String(options['language'] ?? 'auto')
  const pinned = LOCALES[choice]
  if (pinned) t = pinned

  on('session.start', async ($, e, next) => {
    if (!pinned) {
      t = await resolveLocale($)
      $.ui.invalidate('ui.render')
    }
    for (const name of COMMANDS) {
      await $.command.register({ name, description: t.command, argumentHint: '[text | lang <auto|zh|en>]' })
    }

    // Redraw once a second inside the cache's last 5 minutes, every 10 s otherwise
    // (the pace ticks of the rate-limit windows move with the clock too).
    $.clock.every(1000, async () => {
      tick += 1
      const mark = await read($, last)
      const left = mark === null ? Infinity : mark.startedAt + mark.ttlMs - (await $.clock.now())
      if ((left <= 5 * MIN && left > -2000) || tick % 10 === 0) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  // The band does not exist on the phone; a pane does. Put one there when a phone attaches.
  on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
    void $.ui.open({ id: PANE, title: t.title })

    return next(e)
  })

  // /claude-band and its short form /cb: open the pane and answer with the clock as text;
  // `lang <code>` switches the language (stored as the plugin's `language` option).
  for (const command of COMMANDS) {
    on('command.run', { command }, async ($, e) => {
      const [sub, arg] = e.args.trim().split(/\s+/)
      if (sub === 'lang') return { text: await setLanguage($, arg, pinned) }

      // From the phone (Remote Control) no pane can open, so the answer is the clock itself,
      // in plain lines; `/cb text` asks for the same anywhere. Elsewhere the pane opens.
      if (sub === 'text' || e.origin?.kind === 'bridge') {
        const gs = await measure($)
        return { text: [...gs.map(g => summaryLine(opened(g))), spendText(await spending($, gs[0]!))].join('\n') }
      }
      await $.ui.open({ id: PANE, title: t.title })
      return { text: t.paneOpened }
    })
  }

  // One model request: the main conversation's only, subagents are skipped.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const startedAt = await $.clock.now()
      await update($, last, prev => ({
        startedAt,
        ttlMs: DEFAULT_TTL_MS,
        tokens: prev?.tokens ?? 0,
      }))
    }

    return yield* next(e)
  })

  // The answer is in: the context size is what a cold cache would have to re-cache.
  on('turn.complete', async ($, e, next) => {
    // Every turn's tokens count toward the session, a subagent's too; the main loop's model
    // prices the next message.
    const used = e.usage
    if (used !== undefined) {
      const n = used.input_tokens + used.output_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens
      await update($, spent, prev => ({
        tokens: prev.tokens + n,
        model: e.agentId === undefined ? used.model : prev.model,
      }))
    }
    if (e.agentId === undefined) {
      const { context } = await $.session.usage()
      const tokens = context.tokens
      if (tokens !== undefined) {
        await update($, last, prev => (prev === null ? prev : { ...prev, tokens }))
      }
    }

    return next(e)
  })

  // New rate-limit or context figures: draw them now rather than at the next tick.
  on('session.measure', async ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const gs = await measure($)
    const sp = await spending($, gs[0]!)
    const open = await read($, bandOpen)
    const press = (id: GaugeId) => () => void update($, bandOpen, toggleOpen(id))
    // On the right: open every gauge, or close whatever is open.
    const all = {
      key: 'all',
      label: open.length === 0 ? t.expand : t.collapse,
      onPress: () => void update($, bandOpen, now => (now.length === 0 ? [...ORDER] : [])),
    }

    if (e.surface === 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      const draw = (runs: Run[]) => (
        <Box>
          {runs.map(r =>
            r.press ? (
              <Button key={r.press} label={r.text} plain dimColor={r.dim} onPress={press(r.press)} />
            ) : (
              <Text color={r.tone && TERM_COLOR[r.tone]} dimColor={r.dim || r.tone === 'idle'} bold={r.bold}>
                {r.text}
              </Text>
            ),
          )}
        </Box>
      )
      // The spending group joins the line only when the whole line still fits beside it.
      const spendRuns: Run[] = [{ text: '   ' }, { text: spendText(sp, true), dim: true }]
      const isRoomy = e.props.bodyColumns - 6 >= width(bandLine(gs, 1000, open)) + width(spendRuns)
      const line = bandLine(gs, e.props.bodyColumns - 6 - (isRoomy ? width(spendRuns) : 0), open)
      const top = (
        <Box>
          {draw(isRoomy ? [...line, ...spendRuns] : line)}
          <Box flexGrow={1} />
          <Button {...all} plain dimColor />
        </Box>
      )
      if (open.length === 0) return top
      return (
        <Box flexDirection="column">
          {top}
          <Text dimColor>{'─'.repeat(Math.min(e.props.bodyColumns - 1, Math.max(width(line), 40)))}</Text>
          {openedLines(gs, open, e.props.bodyColumns - 1, sp).map(draw)}
        </Box>
      )
    }

    // The desktop: a narrow band leaves the context gauge out of the line.
    const { Box, Button, Svg } = $.ui.resolve(e)
    const room = e.props.bodyColumns * cellPx(e.surface)
    const shown = room < 420 ? gs.slice(0, 3) : gs
    const gauges = (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {shown.map(g => {
          const figure = figureSvg(g)
          return (
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Svg source={miniRingSvg(g)} alt={g.label} width={14} height={BAND_H} />
              <Button key={g.id} label={g.label} plain dimColor={!open.includes(g.id)} onPress={press(g.id)} />
              <Svg source={figure.source} alt={`${g.label} ${g.value} ${detail(g)}`} width={figure.width} height={BAND_H} />
            </Box>
          )
        })}
      </Box>
    )
    // Ring, label button (its text and the desktop's button padding), figure, and the gaps
    // between; measured against the desktop, where four gauges take about 520 px.
    const lineW = shown.reduce((n, g) => n + 14 + textW(g.label, 13) + 30 + figureSvg(g).width + 28, 0)
    // The spending group joins the line only when the band is wide enough for it too.
    const spendLine = spendSvg(sp)
    // Gap before the group (2 cells), the group, the 展开 button with its padding, and some
    // slack: measured on the desktop, a line estimated 13 px short of the band still wrapped.
    const isRoomy = shown.length === gs.length && lineW + 2 * cellPx(e.surface) + spendLine.width + 48 + 32 <= room
    // The line never wraps: were the estimate still wrong, the group is cut, not 展开 pushed down.
    const line = (
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center">
        <Box flexShrink={0}>{gauges}</Box>
        {isRoomy && (
          <Box marginLeft={2} flexShrink={1} overflow="hidden">
            <Svg source={spendLine.source} alt={spendText(sp)} width={spendLine.width} height={BAND_H} />
          </Box>
        )}
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Button {...all} plain dimColor />
        </Box>
      </Box>
    )
    if (open.length === 0) return line

    const rows = openedSvg(gs, open, room - 8, lineW, sp)
    return (
      <Box flexDirection="column">
        {line}
        <Svg
          source={rows.source}
          alt={gs.filter(g => open.includes(g.id)).map(g => { const o = opened(g); return `${o.lead}${o.value}${o.rest} ${o.note}` }).join('；')}
          width={rows.width}
          height={rows.height}
        />
      </Box>
    )
  })

  // Every surface, the phone included.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const gs = await measure($)
    const sp = await spending($, gs[0]!)
    const mark = await read($, last)
    const footer =
      mark === null
        ? t.noRequest
        : t.lastRequest(hhmmss(mark.startedAt), Math.round(mark.ttlMs / MIN))

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {blockLines(gs, e.props.bodyColumns).map(runs => (
            <Box>
              {runs.map(r => (
                <Text color={r.tone && TERM_COLOR[r.tone]} dimColor={r.dim || r.tone === 'idle'} bold={r.bold}>
                  {r.text}
                </Text>
              ))}
            </Box>
          ))}
          <Text> </Text>
          <Text dimColor>{spendText(sp)}</Text>
          <Text dimColor>┃ {t.tickLegend}</Text>
          <Text dimColor>{footer}</Text>
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const room = e.props.bodyColumns * cellPx(e.surface)
    const view = await read($, paneView)
    const pick = (to: GaugeView, label: string) => (
      <Button
        key={to}
        label={label}
        variant={view === to ? 'primary' : 'secondary'}
        onPress={() => void update($, paneView, () => to)}
      />
    )
    const header = (
      <Box flexDirection="row" justifyContent="center" columnGap={1}>
        {pick('ring', t.rings)}
        {pick('bar', t.bars)}
      </Box>
    )
    const footerBox = (
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        <Text dimColor>{spendText(sp)}</Text>
        <Text dimColor>{t.tickLegend}</Text>
        <Text dimColor>{footer}</Text>
      </Box>
    )

    if (view === 'bar') {
      const w = Math.round(Math.min(560, Math.max(240, room - 24)))
      return (
        <Box flexDirection="column" alignItems="center" paddingY={1}>
          {header}
          {gs.map(g => {
            const row = barRowSvg(g, w)
            return (
              <Box marginTop={1}>
                <Svg source={row.source} alt={`${alt(g)} ${detail(g)}`} width={w} height={row.height} />
              </Box>
            )
          })}
          {footerBox}
        </Box>
      )
    }

    // Wide: the four rings in one row. Narrow (the phone, a slim dock): the cache ring
    // on top, the others in a row beneath; the context one goes when even that is too tight.
    const isWide = room >= 600
    const [cache, ...rest] = gs as [Gauge, ...Gauge[]]
    const others = room < 280 ? rest.slice(0, 2) : rest
    const bigSize = isWide ? 152 : Math.round(Math.min(184, Math.max(132, room * 0.5)))
    const smallSize = isWide ? 124 : Math.floor(Math.min(116, Math.max(76, (room - 16) / others.length - 12)))

    const item = (g: Gauge, size: number) => (
      <Box flexDirection="column" alignItems="center" paddingX={1}>
        <Svg source={ringSvg(g, size)} alt={alt(g)} width={size} height={size} />
        <Text bold>{g.label}</Text>
        <Text dimColor>{g.note || ' '}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingY={1}>
        {header}
        <Box marginTop={1} />
        {isWide ? (
          <Box flexDirection="row" justifyContent="space-around" alignItems="flex-start">
            {item(cache, bigSize)}
            {others.map(g => item(g, smallSize))}
          </Box>
        ) : (
          <Box flexDirection="column" alignItems="center">
            {item(cache, bigSize)}
            <Box flexDirection="row" justifyContent="space-around" alignItems="flex-start" marginTop={1}>
              {others.map(g => item(g, smallSize))}
            </Box>
          </Box>
        )}
        {footerBox}
      </Box>
    )
  })
}
