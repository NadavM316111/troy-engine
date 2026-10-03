/* ═══════════════════════════════════════════════════════════════════════════
   SCORE - the pure trade-scoring math. No database, no network.

   Shared by the live scorecard (stats.ts, daily email) and the backtester, so
   a win rate in the email and a win rate in a backtest are the same formula.

     winRate      wins / trades
     avgWin       gross wins / wins
     avgLoss      gross losses / losses            (positive number)
     payoff       avgWin / avgLoss
     breakEven    1 / (1 + payoff)                 win rate needed to net zero
     expectancy   net / trades                     $ per trade, the real edge
     profitFactor gross wins / gross losses        > 1 makes money
     afterCosts   net minus COST_PER_SIDE on entry and exit notional
   ═══════════════════════════════════════════════════════════════════════════ */

export const COST_PER_SIDE = 0.0005   // 5bp per side: spread + slippage on liquid large caps

export interface Score {
  n: number; wins: number; losses: number
  winRate: number
  avgWin: number; avgLoss: number
  payoff: number; breakEvenWinRate: number
  expectancy: number; profitFactor: number
  net: number; netAfterCosts: number
  best: number; worst: number
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
