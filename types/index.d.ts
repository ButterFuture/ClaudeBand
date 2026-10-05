export type CacheMark = {
  /** ms epoch when the last main-conversation request started */
  startedAt: number
  /** cache lifetime assumed for that request, in ms */
  ttlMs: number
  /** prompt tokens that would have to be re-cached if the cache went cold */
  tokens: number
}

/** how the pane draws the gauges: rings, or bars that spell out actual against expected */
export type GaugeView = 'ring' | 'bar'

/** one of the four gauges */
export type GaugeId = 'cache' | 'five' | 'week' | 'ctx'

/** what this session has spent, counted from each finished turn (subagents' included) */
export type Spent = {
  /** input, cache and output tokens of every turn this plugin has seen finish */
  tokens: number
  /** the model the main conversation's last turn ran on, as the API names it */
  model: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'claude-band': { last: CacheMark | null; bandOpen: GaugeId[]; paneView: GaugeView; spent: Spent }
  }
}
