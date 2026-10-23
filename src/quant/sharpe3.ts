/* ═══════════════════════════════════════════════════════════════════════════
   SHARPE3 - round 2: sizing, Bitcoin balance, breakout picks, breakout exits.

     npm run q:sharpe3

   Live TROY code, 1.8x, all costs, 36 combinations. Ranked on 2017-2023 (IS),
   checked on 2024-2026 (OOS). For the best one it also finds the leverage that
   keeps today's ~0.21%/day and shows the worst drop at that leverage.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), mdd: 100 * m, sh: mu / sd * Math.sqrt(252), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1), vol: 100 * sd * Math.sqrt(252) }
}
type Cfg = { size: boolean; bal: boolean; rank: 'ret20' | 'high52' | 'rs'; atr: number }
const label = (c: Cfg) => [c.size && 'size by jumpiness', c.bal && 'BTC risk-balanced', c.rank !== 'ret20' && `rank ${c.rank === 'high52' ? '52-wk high' : 'vs SPY'}`, c.atr && `ATR exit ${c.atr}x`].filter(Boolean).join(' + ') || 'today'
function run(c: Cfg, L = 1.8) {
  const P = PROFILES.TROY
  P.leverage = L; P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false
  P.btcTrendDays = undefined; P.hedgeRatio = undefined; P.hedgeSym = undefined; P.breakoutMarketFilter = false
  P.invVolSizing = c.size; P.btcRiskBalance = c.bal; P.breakoutRank = c.rank; P.breakoutAtrK = c.atr || undefined
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
  for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  return { a: stats(eq), i: stats(eq, 0, SPLIT - START), o: stats(eq, SPLIT - START) }
}
const rows: { c: Cfg; r: ReturnType<typeof run> }[] = []
for (const size of [false, true]) for (const bal of [false, true]) for (const rank of ['ret20', 'high52', 'rs'] as const) for (const atr of [0, 2.5, 3.5]) { const c = { size, bal, rank, atr }; rows.push({ c, r: run(c) }) }
const base = rows.find(x => !x.c.size && !x.c.bal && x.c.rank === 'ret20' && !x.c.atr)!
const H = `${'setup'.padEnd(58)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'worst drop'.padStart(12)}${'swing'.padStart(8)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'OOS/yr'.padStart(9)}${'OOS drop'.padStart(10)}`
const line = (x: typeof rows[number]) => console.log(`${label(x.c).padEnd(58)}${(x.r.a.day.toFixed(3) + '%').padStart(9)}${(x.r.a.cagr.toFixed(1) + '%').padStart(10)}${('-' + x.r.a.mdd.toFixed(1) + '%').padStart(12)}${(x.r.a.vol.toFixed(0) + '%').padStart(8)}${x.r.a.sh.toFixed(2).padStart(8)}${x.r.i.sh.toFixed(2).padStart(8)}${x.r.o.sh.toFixed(2).padStart(9)}${(x.r.o.cagr.toFixed(1) + '%').padStart(9)}${('-' + x.r.o.mdd.toFixed(1) + '%').padStart(10)}`)
console.log(`\nSHARPE3: live TROY, 1.8x, all costs, ${iso(dates[START])} to ${iso(dates[N - 1])}. 36 setups, ranked on 2017-2023 (IS), checked on 2024-26 (OOS).\n`)
console.log(H); console.log('-'.repeat(H.length))
console.log('-- today --'); line(base)
console.log('-- each idea on its own --')
for (const x of rows.filter(y => [y.c.size, y.c.bal, y.c.rank !== 'ret20', !!y.c.atr].filter(Boolean).length === 1)) line(x)
const ranked = [...rows].sort((a, b) => b.r.i.sh - a.r.i.sh)
console.log('-- top 10 by IS Sharpe --'); for (const x of ranked.slice(0, 10)) line(x)
const best = ranked[0]
const good = best.r.i.sh > base.r.i.sh + 0.05 && best.r.o.sh >= base.r.o.sh - 0.05
console.log(`\nBest: ${label(best.c)} -> Sharpe ${best.r.a.sh.toFixed(2)} (today ${base.r.a.sh.toFixed(2)}), IS ${best.r.i.sh.toFixed(2)} vs ${base.r.i.sh.toFixed(2)}, OOS ${best.r.o.sh.toFixed(2)} vs ${base.r.o.sh.toFixed(2)}.`)
if (good) {
  let pick = { L: 1.8, r: best.r }
  for (const L of [1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3]) { const r = run(best.c, L); if (r.a.day >= base.r.a.day) { pick = { L, r }; break } }
  console.log(`At ${pick.L}x it makes ${pick.r.a.day.toFixed(3)}%/day (${pick.r.a.cagr.toFixed(1)}%/yr) with a worst drop of -${pick.r.a.mdd.toFixed(1)}%, vs today's ${base.r.a.day.toFixed(3)}%/day and -${base.r.a.mdd.toFixed(1)}%.`)
  console.log(`VERDICT: real improvement (better in-sample, holds up out of sample).`)
} else console.log(`VERDICT: nothing clearly beats today's setup in both periods.`)
console.log('')
