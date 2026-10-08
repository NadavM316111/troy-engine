/* ═══════════════════════════════════════════════════════════════════════════
   SWING PARITY - replays the LIVE swing code (swing/core.ts) over the cached
   10 years and checks it reproduces the research result that passed.

     npm run q:parity

   If the live code and the research disagree, the live code is not the
   strategy that was tested, and it must not be deployed. This is the proof.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade, type ProfileId } from '../swing/core.js'

// The research rows each book must match (full universe, 5bp per side).
const RESEARCH: Partial<Record<ProfileId, { src: string; trades: number; win: number; cagr: number; sharpe: number; mdd: number }>> = {
  COMBO:   { src: 'q:swing "Combo: breakout + RSI2 dips"', trades: 1011, win: 52.3, cagr: 27.3, sharpe: 1.30, mdd: 22 },
  HIGHWIN: { src: 'q:winrate "RSI2<5, exit any close above entry"', trades: 2000, win: 75.9, cagr: 9.6, sharpe: 0.87, mdd: 19 },
}

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const universe = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days
const START = 210
let allOk = true

for (const id of Object.keys(RESEARCH) as ProfileId[]) {
  let n = 0
  const book = newBook(1_000_000, dates[START], id)
  const trades: SwingTrade[] = []
  const eq: number[] = []
  for (let t = START; t < dates.length; t++) {
    const day = dates[t]
    trades.push(...execute(book, S, day, () => String(++n)))
    eq.push(markEquity(book, S, day))
    if (t < dates.length - 1) decide(book, S, universe, day)
  }
  const lastDay = dates[dates.length - 1]
  for (const p of book.positions) { const s = S[p.sym]; const px = s.fc[s.idx.get(lastDay) ?? s.days.length - 1]; trades.push({ id: 'open', sym: p.sym, leg: p.leg, action: 'SELL', day: lastDay, price: px, shares: p.shares, total: 0, ret: px / p.entryPx - 1, net: (px * 0.9995) / (p.entryPx * 1.0005) - 1, reason: 'open at end' }) }
  const sells = trades.filter(x => x.action === 'SELL')
  const win = 100 * sells.filter(x => (x.ret ?? 0) > 0).length / sells.length
  const rets = eq.slice(1).map((v, i) => v / eq[i] - 1)
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mu) ** 2, 0) / (rets.length - 1))
  const cagr = 100 * (Math.pow(eq[eq.length - 1] / eq[0], 252 / (eq.length - 1)) - 1)
  let pk = eq[0], mdd = 0; for (const v of eq) { pk = Math.max(pk, v); mdd = Math.max(mdd, 1 - v / pk) }
  const live = { trades: sells.length, win: +win.toFixed(1), cagr: +cagr.toFixed(1), sharpe: +((mu / sd) * Math.sqrt(252)).toFixed(2), mdd: +(mdd * 100).toFixed(0) }
  const R = RESEARCH[id]!
  console.log(`\n${PROFILES[id].title}  (live code vs ${R.src})`)
  console.log(`${''.padEnd(14)}${'live code'.padStart(12)}${'research'.padStart(12)}`)
  for (const [k, a, b, u] of [['trades', live.trades, R.trades, ''], ['win rate', live.win, R.win, '%'], ['CAGR', live.cagr, R.cagr, '%'], ['Sharpe', live.sharpe, R.sharpe, ''], ['max drawdown', live.mdd, R.mdd, '%']] as [string, number, number, string][])
    console.log(`${k.padEnd(14)}${(a + u).padStart(12)}${(b + u).padStart(12)}`)
  for (const leg of PROFILES[id].legs) {
    const x = sells.filter(s => s.leg === leg.leg)
    console.log(`  ${leg.leg} leg: ${x.length} trades, ${(100 * x.filter(s => (s.ret ?? 0) > 0).length / Math.max(1, x.length)).toFixed(1)}% win, avg ${(100 * x.reduce((a, s) => a + (s.net ?? 0), 0) / Math.max(1, x.length)).toFixed(2)}% after costs`)
  }
  const okP = Math.abs(live.trades - R.trades) / R.trades < 0.06 && Math.abs(live.cagr - R.cagr) < 2.5 && Math.abs(live.win - R.win) < 2.5 && Math.abs(live.sharpe - R.sharpe) < 0.12
  console.log(okP ? '  match' : '  MISMATCH')
  allOk &&= okP
}
console.log(`\n${allOk ? 'PARITY OK: the live code reproduces every tested strategy. Safe to deploy.' : 'PARITY MISMATCH: do not deploy. Paste this output to Claude.'}\n`)
