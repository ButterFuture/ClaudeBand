import type { Locale } from './types'

export default {
  code: 'zh',
  name: '简体中文',
  match: /^zh|chinese|中文|汉语|漢語|简体|繁體/i,

  title: 'ClaudeBand',
  command: 'ClaudeBand：缓存剩余、5 小时与周限用量、上下文与花费（/cb lang 切换语言）',
  labels: { cache: '缓存', five: '5 小时', week: '周限', ctx: '上下文' },

  span: (d, h, m) => (d > 0 ? `${d}天${h}时` : h > 0 ? `${h}时${m === 0 ? '' : `${m}分`}` : `${m}分`),
  minutes: m => `${m}分`,
  spaced: value => value.replace('分', ' 分'),

  waiting: '待开始',
  startsNext: '下一条消息开始计时',
  expired: '已过期',
  expiredAt: hm => `${hm} 过期`,
  recache: k => `下条消息重写 ~${k}`,
  until: hm => `${hm} 到期`,
  cached: k => `已缓存 ~${k}`,
  left: span => `剩余 ${span}`,
  noReading: '暂无读数',
  nextReply: '等下一次回复',
  reset: '已重置',
  resetAt: hm => `${hm} 重置`,
  resetsIn: span => `${span}后重置`,
  expect: p => `预期 ${p}%`,
  used: '已用',
  window: k => `窗口 ${k}`,
  detail: (used, pace, gap) =>
    `实际 ${used}% · 预期 ${pace}% · ${gap === 0 ? '持平' : gap > 0 ? `超前 ${gap}%` : `落后 ${-gap}%`}`,

  spend: { next: '下条预计', tokens: '会话用量', cost: '会话花费' },
  spendBrief: { next: '预计', tokens: '用量', cost: '花费' },

  cacheLeft: '缓存剩余 ',
  usedLead: label => `${label}已用 `,
  expectRest: p => `，预期 ${p}%`,

  expand: '展开',
  collapse: '收起',
  noRequest: '还没有请求：发一条消息后缓存开始计时',
  lastRequest: (time, ttlMin) => `上次请求 ${time} · 缓存时长 ${ttlMin} 分钟`,
  tickLegend: '竖线：按时间平均消耗，此刻应到的位置',
  rings: '圆环',
  bars: '条形',

  langNow: (current, choices) => `当前语言：${current}。可选：${choices}`,
  langSet: name => `语言已设为 ${name}`,
  langAuto: name => `语言改为自动（现在是 ${name}）`,
  langUnknown: (code, choices) => `没有「${code}」这种语言。可选：${choices}`,
  paneOpened: '已打开 ClaudeBand 面板，用 /cb lang <语言> 切换语言',
  aside: text => `（${text}）`,
} satisfies Locale
