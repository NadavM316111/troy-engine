/* ═══════════════════════════════════════════════════════════════════════════
   TROY ENGINE — shared types

   These mirror the browser's types exactly. Keep them in sync: the UI reads
   the same jsonb blob the engine writes, so a divergence here shows up as
   silently missing fields in the interface rather than as an error.
   ═══════════════════════════════════════════════════════════════════════════ */

export type MarketSession = 'premarket' | 'regular' | 'afterhours' | 'closed'
export type Regime = 'FULL_GREEN' | 'SEMI_GREEN' | 'MIXED_RED' | 'FULL_RED'
export type ActiveMode = 'PENDING' | 'BEAST_PLUS' | 'BEAST' | 'ALGO_X' | 'NO_TRADE'

export interface VAP { lo: number; hi: number; bins: number[] }

export interface Quote {
  price: number; changePct: number; high: number; low: number; prevClose: number
  source: string
  rvol?: number | null
  vap?: VAP | null
  dollarVol?: number | null
}

export interface Trade {
  id: string; ticker: string; action: 'BUY' | 'SELL'
  shares: number; price: number; total: number
  reasoning: string; timestamp: number; pnl?: number
  conviction: 'HIGH' | 'MEDIUM' | 'LOW'; signal?: string
  sleeve?: 'MAIN' | 'SAFE'
}

export interface Position {
  ticker: string; shares: number; entryShares: number
  avgPrice: number; currentPrice: number; value: number
  pnl: number; pnlPct: number; sector: string
  stopLevel: number; targetPrice: number; highWatermark: number
  partialDone: boolean; entryTime: number; bars: number[]
  isSafe: boolean; entrySignal?: string
  maxFavorable?: number; weakSince?: number
  peakSince?: number; preTrailLow?: number
  pivot?: number; pyramids?: number; isZanger?: boolean
  frozenStop?: number; benchExtended?: boolean
  bandLine?: number; sellLine?: number
  escalated?: boolean; escUsed?: boolean; escDeadline?: number
  floorTouchedAt?: number
}

export interface DayName { t: string; pnl: number; fills: number; sleeve: 'MAIN' | 'SAFE' }

export interface DaySummary {
  day: number; date: string; label: string
  openValue: number; closeValue: number
  high: number; low: number
  pnl: number; pnlPct: number
  trades: number; wins: number; losses: number
  mainPnl: number; safePnl: number
  regime: string; mode: string
  names: DayName[]
  path: number[]
  closed: boolean
}

export interface PortfolioState {
  budget: number; targetReturn: number; stocks: string[]
  aiPicksStocks: boolean; cash: number; positions: Position[]
  trades: Trade[]; totalValue: number; totalPnl: number
  totalPnlPct: number; dayPnl: number; dayPnlPct: number
  lastUpdated: number; troyThesis: string; marketCondition: string
  nextAction: string; riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'DEFENSIVE'
  scanCount: number; startDate: number
  valueHistory: { t: number; v: number }[]; isPaper: true
  winCount: number; lossCount: number; realizedPnl: number
  safeAlloc: number; riskAlloc: number; allIn: boolean
  withdrawn: boolean; withdrawnValue: number
  zangerMode: boolean; beastMode: boolean; regimeRouter: boolean
  regime: 'PENDING' | Regime
  activeMode: ActiveMode
  roster: string[]; bench: string[]
  switchBudget: number; lastRegimeEvalMin: number
  beastLockedOut: boolean; universeDefect: boolean
  lessonsLedger: string[]; lastReviewDay: number
  dailyLog: DaySummary[]
  currentDay: number; dayOpenValue: number
}

/* The refs the browser held in memory. Persisted per user so a restart does not
   silently reset cooldowns, strikes and locks mid-session. */
export interface EngineRefs {
  cooldown: Record<string, number>
  scratch: Record<string, { count: number; frozenUntil: number }>
  gStock: string[]
  fkStrike: Record<string, number>
  fkLock: Record<string, number>
  a2Strike: Record<string, number>
  dropStrike: Record<string, number>
  ss62Bump: Record<string, number>
  ss62Block: Record<string, number>
  ss62Count: number
  handicap: Record<string, number>
  orb: Record<string, { orHigh: number; orLow: number; attempts: number } | null>
  ss39: Record<string, SS39Ctx>
  candleBucket: number
  dayPathMin: number
}

export type SS39State = 'WAIT_BREAK' | 'WAIT_RETEST' | 'WAIT_CONFIRM' | 'FAILED' | 'EXPIRED'
export interface SS39Ctx {
  state: SS39State; level: number; side: 'LONG' | null
  barsSince: number; retestLow: number; retestHigh: number
}

export function emptyRefs(): EngineRefs {
  return {
    cooldown: {}, scratch: {}, gStock: [], fkStrike: {}, fkLock: {},
    a2Strike: {}, dropStrike: {}, ss62Bump: {}, ss62Block: {}, ss62Count: 0,
    handicap: {}, orb: {}, ss39: {}, candleBucket: -1, dayPathMin: -1,
  }
}

export interface UserRow {
  user_id: string
  email: string
  display_name: string | null
  active: boolean
  email_enabled: boolean
  state: PortfolioState
}
