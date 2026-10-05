// The contract every language file fills. To add a language, copy en.ts to <code>.ts,
// translate each value, and list it in index.ts (see docs/TRANSLATING.md). TypeScript
// flags a missing or misspelt key, so `npx tsc -p .` is the check.
//
// Functions take numbers and already-formatted pieces (times like 14:32, token counts
// like 85k, spans built by `span`) and return the whole phrase, so word order is yours.

export type Locale = {
  /** BCP 47-ish code, also the value of the `language` option: `zh`, `en`, `ja` */
  code: string
  /** the language's own name, shown by `/cb lang`: 简体中文, English, 日本語 */
  name: string
  /** what in Claude Code's `language` setting or in LANG means this language */
  match: RegExp

  /** the pane's title */
  title: string
  /** one line for /cb and /claude-band in the command list */
  command: string
  /** the four gauges, as short as they can be: they sit side by side on one line */
  labels: { cache: string; five: string; week: string; ctx: string }

  /** a length of time: days and hours, or hours and minutes (d is 0 then), or minutes */
  span: (d: number, h: number, m: number) => string
  /** the cache's minutes left, large in the ring: 42分, 42m */
  minutes: (m: number) => string
  /** the same figure inside a sentence (42 分); return it unchanged if nothing differs */
  spaced: (value: string) => string

  waiting: string
  startsNext: string
  expired: string
  expiredAt: (hm: string) => string
  /** k: a token count such as 120k */
  recache: (k: string) => string
  until: (hm: string) => string
  cached: (k: string) => string
  left: (span: string) => string
  noReading: string
  nextReply: string
  reset: string
  resetAt: (hm: string) => string
  resetsIn: (span: string) => string
  /** p: whole percent the pace expects */
  expect: (p: number) => string
  used: string
  window: (k: string) => string
  /** used and pace in whole percent; gap = used - pace (0 on pace, > 0 ahead, < 0 behind) */
  detail: (used: number, pace: number, gap: number) => string

  /** the spending group in full (pane, opened rows) and brief (the band's collapsed line) */
  spend: { next: string; tokens: string; cost: string }
  spendBrief: { next: string; tokens: string; cost: string }

  /** opened rows: "Cache left " + 42m */
  cacheLeft: string
  /** opened rows: "5h used " + 58% */
  usedLead: (label: string) => string
  /** opened rows: + ", expected 40%" */
  expectRest: (p: number) => string

  expand: string
  collapse: string
  noRequest: string
  lastRequest: (time: string, ttlMin: number) => string
  tickLegend: string
  rings: string
  bars: string

  /** `/cb lang`: the current setting and what can be chosen */
  langNow: (current: string, choices: string) => string
  /** `/cb lang <code>` done */
  langSet: (name: string) => string
  /** `/cb lang auto` done; name: what it resolved to now */
  langAuto: (name: string) => string
  /** `/cb lang <code>` with a code no file provides */
  langUnknown: (code: string, choices: string) => string
  /** /cb's answer where the pane opened (desktop, terminal), with the language hint */
  paneOpened: string
  /** a note after a sentence in /cb's phone answer: （…） or " (…)" */
  aside: (text: string) => string
}
