import type { Locale } from './types'

// The template for a new language: copy this file, keep the keys, translate the values.
export default {
  code: 'en',
  name: 'English',
  match: /^en|english/i,

  title: 'ClaudeBand',
  command: 'ClaudeBand: cache time left, 5-hour and weekly limits, context and spend (/cb lang to switch language)',
  labels: { cache: 'Cache', five: '5h', week: 'Weekly', ctx: 'Context' },

  span: (d, h, m) => (d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h${m === 0 ? '' : ` ${m}m`}` : `${m}m`),
  minutes: m => `${m}m`,
  spaced: value => value,

  waiting: 'waiting',
  startsNext: 'starts with your next message',
  expired: 'expired',
  expiredAt: hm => `expired ${hm}`,
  recache: k => `next message re-caches ~${k}`,
  until: hm => `until ${hm}`,
  cached: k => `~${k} cached`,
  left: span => `${span} left`,
  noReading: 'no reading',
  nextReply: 'after the next reply',
  reset: 'reset',
  resetAt: hm => `reset ${hm}`,
  resetsIn: span => `resets in ${span}`,
  expect: p => `expected ${p}%`,
  used: 'used',
  window: k => `window ${k}`,
  detail: (used, pace, gap) =>
    `actual ${used}% · expected ${pace}% · ${gap === 0 ? 'on pace' : gap > 0 ? `${gap}% ahead` : `${-gap}% behind`}`,

  spend: { next: 'Next message', tokens: 'Session tokens', cost: 'Session cost' },
  spendBrief: { next: 'Next', tokens: 'Tokens', cost: 'Cost' },

  cacheLeft: 'Cache left ',
  usedLead: label => `${label} used `,
  expectRest: p => `, expected ${p}%`,

  expand: 'Expand',
  collapse: 'Collapse',
  noRequest: 'No request yet: the cache clock starts with your next message',
  lastRequest: (time, ttlMin) => `Last request ${time} · cache TTL ${ttlMin} min`,
  tickLegend: 'Tick: where even use over the window would be by now',
  rings: 'Rings',
  bars: 'Bars',

  langNow: (current, choices) => `Language: ${current}. Choices: ${choices}`,
  langSet: name => `Language set to ${name}`,
  langAuto: name => `Language follows your settings (now ${name})`,
  langUnknown: (code, choices) => `No language "${code}". Choices: ${choices}`,
  paneOpened: 'Opened the ClaudeBand pane. Switch language with /cb lang <language>',
  aside: text => ` (${text})`,
} satisfies Locale
