/* npm run q:holdtest   breakout max-hold sweep inside TROY (live code, 1.8x, all costs). Dips stay at 10 days. */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), mdd: 100 * m, sh: mu / sd * Math.sqrt(252), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1) }
}
const P = PROFILES.TROY; P.leverage = 1.8; P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false
const brk = P.legs.find(l => l.leg === 'BREAKOUT')!, orig = brk.maxHold
console.log(`\nBREAKOUT MAX HOLD: live TROY, 1.8x, all costs, ${iso(dates[START])} to ${iso(dates[N - 1])}. Dips stay at 10 days. OOS = after ${iso(dates[SPLIT])}.\n`)
const H = `${'breakout max hold'.padEnd(24)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'worst drop'.padStart(12)}${'Sharpe'.padStart(8)}${'OOS/yr'.padStart(9)}${'OOS drop'.padStart(10)}${'brk win'.padStart(9)}${'brk avg win'.padStart(13)}${'brk avg loss'.padStart(14)}${'brk hold'.padStart(10)}${'hit limit'.padStart(11)}`
console.log(H); console.log('-'.repeat(H.length))
for (const mh of [20, 30, 45, 60, 90, 9999]) {
  brk.maxHold = mh
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; const tr: SwingTrade[] = []; let n = 0
  for (let t = START; t < N; t++) { const d = dates[t]; tr.push(...execute(book, S, d, () => String(++n), {})); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  const a = stats(eq), o = stats(eq, SPLIT - START)
  const b = tr.filter(x => x.action === 'SELL' && x.leg === 'BREAKOUT' && !x.reason.startsWith('trim'))
  const w = b.filter(x => (x.net ?? 0) > 0), l = b.filter(x => (x.net ?? 0) <= 0)
  const avg = (q: SwingTrade[], f: (x: SwingTrade) => number) => q.length ? q.reduce((s, x) => s + f(x), 0) / q.length : 0
  const lim = b.filter(x => x.reason.startsWith('time limit')).length
  const label = mh >= 9999 ? 'no limit' : `${mh} days${mh === orig ? ' (today)' : ''}`
  console.log(`${label.padEnd(24)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${(o.cagr.toFixed(1) + '%').padStart(9)}${('-' + o.mdd.toFixed(1) + '%').padStart(10)}${(100 * w.length / Math.max(1, b.length)).toFixed(1).padStart(8)}%${(avg(w, x => 100 * (x.net ?? 0)).toFixed(1) + '%').padStart(13)}${(avg(l, x => 100 * (x.net ?? 0)).toFixed(1) + '%').padStart(14)}${avg(b, x => x.holdDays ?? 0).toFixed(0).padStart(10)}${(100 * lim / Math.max(1, b.length)).toFixed(0).padStart(10)}%`)
}
brk.maxHold = orig
console.log(`\n"hit limit" = share of breakouts sold because they ran out of time (the rest were sold by the 10-day-low rule).\n`)
