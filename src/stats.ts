/* ═══════════════════════════════════════════════════════════════════════════
   STATS — the scorecard. The proof layer.

   Win rate alone lies. A book that wins 90% of trades at +$1 and loses 10% at
   -$15 is a losing book with a great-looking number. So every win rate here is
   shown next to the numbers that decide whether it actually makes money:

     expectancy     average $ per trade, wins and losses together. > 0 = edge.
     profit factor  gross wins / gross losses. > 1 makes money, > 1.5 is good.
     payoff         avg win / avg loss. Win rate needed to break even is
                    1 / (1 + payoff).
     after costs    every fill here is at last price with no spread. This
                    subtracts an assumed 5bp per side so the number is honest.

   Only SELL rows count, since they are the only rows carrying realized P&L.
   MAIN sleeve is the trading book. SAFE is the parking sleeve, shown apart.
   ═══════════════════════════════════════════════════════════════════════════ */

import { sellsSince, dailyRows } from './db.js'
import { etDayKey } from './quotes.js'

export const WIN_RATE_GOAL = 90
export const COST_PER_SIDE = 0.0005

export interface Score {
  n: number; wins: number; losses: number
  winRate: number
  avgWin: number; avgLoss: number
  payoff: number; breakEvenWinRate: number
  expectancy: number; profitFactor: number
  net: number; netAfterCosts: number
  best: number; worst: number
}

export interface SignalScore extends Score { signal: string }

export interface Scorecard {
  today: Score; last10: Score; allTime: Score
  bySignal: SignalScore[]
  safeAllTime: Score
  days: { n: number; green: number; greenPct: number; maxDrawdownPct: number }
}

const r2 = (x: number) => Math.round(x * 100) / 100

export function score(rows: { pnl: number; total: number }[]): Score {
  const pn = rows.map(r => Number(r.pnl))
  const w = pn.filter(p => p > 0), l = pn.filter(p => p <= 0)
  const gw = w.reduce((s, p) => s + p, 0), gl = -l.reduce((s, p) => s + p, 0)
  const avgWin = w.length ? gw / w.length : 0
  const avgLoss = l.length ? gl / l.length : 0
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0
  const net = gw - gl
  // round trip cost: entry notional ~ (total - pnl), exit notional = total
  const costs = rows.reduce((s, r) => s + COST_PER_SIDE * (Math.abs(Number(r.total) - Number(r.pnl)) + Math.abs(Number(r.total))), 0)
  return {
    n: pn.length, wins: w.length, losses: l.length,
    winRate: pn.length ? r2(100 * w.length / pn.length) : 0,
    avgWin: r2(avgWin), avgLoss: r2(avgLoss),
    payoff: r2(payoff),
    breakEvenWinRate: payoff > 0 ? r2(100 / (1 + payoff)) : 0,
    expectancy: pn.length ? r2(net / pn.length) : 0,
    profitFactor: gl > 0 ? r2(gw / gl) : (gw > 0 ? 99 : 0),
    net: r2(net), netAfterCosts: r2(net - costs),
    best: pn.length ? r2(Math.max(...pn)) : 0,
    worst: pn.length ? r2(Math.min(...pn)) : 0,
  }
}

export async function buildScorecard(userId: string): Promise<Scorecard> {
  const today = etDayKey()
  const all = await sellsSince(userId, 0)
  const main = all.filter(r => r.sleeve !== 'SAFE')
  const safe = all.filter(r => r.sleeve === 'SAFE')

  const tradingDays = [...new Set(main.map(r => Number(r.day)))].sort((a, b) => a - b)
  const last10Start = tradingDays.length > 10 ? tradingDays[tradingDays.length - 10] : 0

  const groups: Record<string, any[]> = {}
  for (const r of main) (groups[r.signal ?? 'UNKNOWN'] ??= []).push(r)
  const bySignal = Object.entries(groups)
    .map(([signal, rows]) => ({ signal, ...score(rows) }))
    .sort((a, b) => a.net - b.net)

  const dl = await dailyRows(userId)
  const closes = dl.map(d => d.row).filter((r: any) => r?.closed)
  const green = closes.filter((r: any) => r.pnl > 0).length
  let peak = 0, mdd = 0
  for (const r of closes) {
    const v = Number(r.closeValue)
    peak = Math.max(peak, v)
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak)
  }

  return {
    today: score(main.filter(r => Number(r.day) === today)),
    last10: score(main.filter(r => Number(r.day) >= last10Start)),
    allTime: score(main),
    bySignal,
    safeAllTime: score(safe),
    days: { n: closes.length, green, greenPct: closes.length ? r2(100 * green / closes.length) : 0, maxDrawdownPct: r2(mdd * 100) },
  }
}

export function scoreLine(label: string, s: Score): string {
  if (!s.n) return `${label}: no closed trades`
  return `${label}: ${s.n} trades, ${s.winRate}% win (goal ${WIN_RATE_GOAL}%), avg win $${s.avgWin} / avg loss $${s.avgLoss}, ` +
    `expectancy $${s.expectancy}/trade, PF ${s.profitFactor}, net $${s.net} ($${s.netAfterCosts} after costs)`
}
