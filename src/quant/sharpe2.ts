/* ═══════════════════════════════════════════════════════════════════════════
   SHARPE2 - can TROY get from Sharpe 1.65 toward 1.85-2.0?

     npm run q:sharpe2

   Live TROY code, 1.8x, all costs, 64 combinations of three ideas aimed at
   the causes of its worst drops:
     Bitcoin exit speed   trend average of 50, 75, 100 (today) or 150 days
     market hedge         short SPY or QQQ worth 25-100% of the stocks,
                          always or only while SPY is below its 200-day average
     breakout filter      no new breakouts while SPY is below its 200-day average
   Ranked on 2017-2023 only, then checked on 2024-2026.
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
type H = { ratio: number; sym: string; mode: 'always' | 'downtrend' } | null
type Cfg = { btc: number; hedge: H; bf: boolean }
const label = (c: Cfg) => `BTC ${c.btc}d${c.hedge ? `, short ${c.hedge.sym} ${c.hedge.ratio * 100}% ${c.hedge.mode === 'always' ? 'always' : 'in downtrends'}` : ''}${c.bf ? ', breakout filter' : ''}`
function run(c: Cfg) {
  const P = PROFILES.TROY
  P.leverage = 1.8; P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false
  P.btcTrendDays = c.btc; P.hedgeRatio = c.hedge?.ratio; P.hedgeSym = c.hedge?.sym; P.hedgeMode = c.hedge?.mode; P.breakoutMarketFilter = c.bf
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
  for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  return { a: stats(eq), i: stats(eq, 0, SPLIT - START), o: stats(eq, SPLIT - START) }
}
const hedges: H[] = [null, { ratio: 0.25, sym: 'SPY', mode: 'always' }, { ratio: 0.5, sym: 'SPY', mode: 'always' }, { ratio: 0.5, sym: 'SPY', mode: 'downtrend' }, { ratio: 1, sym: 'SPY', mode: 'downtrend' }, { ratio: 0.5, sym: 'QQQ', mode: 'always' }, { ratio: 0.5, sym: 'QQQ', mode: 'downtrend' }, { ratio: 1, sym: 'QQQ', mode: 'downtrend' }]
const rows: { c: Cfg; r: ReturnType<typeof run> }[] = []
for (const btc of [50, 75, 100, 150]) for (const hedge of hedges) for (const bf of [false, true]) rows.push({ c: { btc, hedge, bf }, r: run({ btc, hedge, bf }) })
const base = rows.find(x => x.c.btc === 100 && !x.c.hedge && !x.c.bf)!
const H = `${'setup'.padEnd(54)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'worst drop'.padStart(12)}${'swing'.padStart(8)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'OOS/yr'.padStart(9)}${'OOS drop'.padStart(10)}`
const line = (x: typeof rows[number]) => console.log(`${label(x.c).padEnd(54)}${(x.r.a.day.toFixed(3) + '%').padStart(9)}${(x.r.a.cagr.toFixed(1) + '%').padStart(10)}${('-' + x.r.a.mdd.toFixed(1) + '%').padStart(12)}${(x.r.a.vol.toFixed(0) + '%').padStart(8)}${x.r.a.sh.toFixed(2).padStart(8)}${x.r.i.sh.toFixed(2).padStart(8)}${x.r.o.sh.toFixed(2).padStart(9)}${(x.r.o.cagr.toFixed(1) + '%').padStart(9)}${('-' + x.r.o.mdd.toFixed(1) + '%').padStart(10)}`)
console.log(`\nSHARPE2: live TROY, 1.8x, all costs, ${iso(dates[START])} to ${iso(dates[N - 1])}. 64 setups, ranked on 2017-2023 (IS), checked on 2024-26 (OOS).\n`)
console.log(H); console.log('-'.repeat(H.length))
console.log('-- today --'); line(base)
const ranked = [...rows].sort((a, b) => b.r.i.sh - a.r.i.sh)
console.log('-- top 12 by IS Sharpe --'); for (const x of ranked.slice(0, 12)) line(x)
const best = ranked[0]
console.log(`\nNeighbor check on the best setup (vary only the Bitcoin speed): ${[50, 75, 100, 150].map(b => { const x = rows.find(y => y.c.btc === b && JSON.stringify(y.c.hedge) === JSON.stringify(best.c.hedge) && y.c.bf === best.c.bf)!; return `${b}d Sharpe ${x.r.a.sh.toFixed(2)}` }).join(', ')}`)
const ok = best.r.i.sh > base.r.i.sh + 0.05 && best.r.o.sh >= base.r.o.sh - 0.05
console.log(`\nBest: ${label(best.c)} -> Sharpe ${best.r.a.sh.toFixed(2)} (today ${base.r.a.sh.toFixed(2)}), ${best.r.a.cagr.toFixed(1)}%/yr, worst drop -${best.r.a.mdd.toFixed(1)}%, on 2024-26 Sharpe ${best.r.o.sh.toFixed(2)} (today ${base.r.o.sh.toFixed(2)}).`)
console.log(ok ? `VERDICT: real improvement (better in-sample, holds up out of sample).` : `VERDICT: nothing clearly beats today's setup in both periods.`)
console.log(`Note: Sharpe doesn't change with leverage, so a winner can be re-levered to hit 0.20%/day with a smaller drop.\n`)
