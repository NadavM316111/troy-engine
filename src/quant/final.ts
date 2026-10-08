/* ═══════════════════════════════════════════════════════════════════════════
   FINAL - replays the LIVE TROY book (swing/core.ts) over ~9 years.

     npm run q:final

   This is the exact code Railway runs, with every real cost in it: 5bp per
   side on stocks, 15bp per side on Bitcoin, 5%/yr on borrowed money, 4%/yr
   earned on idle cash, trims when leverage drifts. A win only counts if the
   trade made money AFTER costs.

   It also answers the open question: sell exits at the close (decide at the
   close, sell at the close) vs at the next morning's open.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
if (!raw['BTC-USD']) throw new Error('BTC-USD missing: run npm run q:daily -- BTC-USD')
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)

function run(L: number, atClose: boolean) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = atClose
  const book = newBook(1, dates[START], 'TROY')
  const eq: number[] = []; const trades: SwingTrade[] = []; let n = 0, grossSum = 0
  const id = () => String(++n)
  for (let t = START; t < N; t++) {
    const d = dates[t]
    trades.push(...execute(book, S, d, id, {}))
    const e = markEquity(book, S, d, { btcDay: d - 1 }); eq.push(e)
    const stocks = book.positions.reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0)
    grossSum += (stocks + (book.btc ? book.btc.units * (book.btc.lastPx ?? book.btc.avgPx) : 0)) / Math.max(1e-9, e)
    if (t < N - 1) { const p = decide(book, S, U, d, { btcDay: d - 1 }, id); trades.push(...(p.closeFills ?? [])) }
  }
  return { eq, trades, book, gross: grossSum / (N - START) }
}
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), mdd: 100 * m, sh: mu / sd * Math.sqrt(252), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1) }
}
function worstMonth(eq: number[]) { const ends = new Map<string, number>(); eq.forEach((_, k) => ends.set(iso(dates[START + k]).slice(0, 7), k)); let prev = 0, w = 0, neg = 0, n = 0; for (const k of ends.values()) { if (k === prev) continue; const x = eq[k] / eq[prev] - 1; w = Math.min(w, x); n++; if (x < 0) neg++; prev = k } return { worst: 100 * w, negPct: 100 * neg / n } }
function underwater(eq: number[]) { let pk = eq[0], c = 0, w = 0; for (const x of eq) { if (x >= pk) { pk = x; c = 0 } else { c++; w = Math.max(w, c) } } return w }

console.log(`\nFINAL: live TROY code, ${iso(dates[START])} to ${iso(dates[N - 1])}. ${U.length} stocks + Bitcoin. OOS = after ${iso(dates[SPLIT])}.\n`)
const H = `${'setup'.padEnd(22)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'worst drop'.padStart(12)}${'worst mo'.padStart(10)}${'neg mo'.padStart(8)}${'recovery'.padStart(10)}${'Sharpe'.padStart(8)}${'OOS/yr'.padStart(9)}${'OOS drop'.padStart(10)}${'win% (net)'.padStart(12)}${'trades/yr'.padStart(11)}${'avg lev'.padStart(9)}`
console.log(H); console.log('-'.repeat(H.length))
const rows: any[] = []
for (const atClose of [false, true]) for (const L of [1, 1.45, 1.8, 2]) {
  const { eq, trades, book, gross } = run(L, atClose)
  const a = stats(eq), o = stats(eq, SPLIT - START), m = worstMonth(eq)
  const closed = trades.filter(x => x.action === 'SELL' && !x.reason.startsWith('trim'))
  const wins = closed.filter(x => (x.net ?? 0) > 0).length
  const yrs = (N - START) / 252
  const label = `${L}x, sell at ${atClose ? 'close' : 'open'}`
  console.log(`${label.padEnd(22)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${(m.worst.toFixed(1) + '%').padStart(10)}${(m.negPct.toFixed(0) + '%').padStart(8)}${(underwater(eq) + 'd').padStart(10)}${a.sh.toFixed(2).padStart(8)}${(o.cagr.toFixed(1) + '%').padStart(9)}${('-' + o.mdd.toFixed(1) + '%').padStart(10)}${(100 * wins / Math.max(1, closed.length)).toFixed(1).padStart(12)}${(closed.length / yrs).toFixed(0).padStart(11)}${gross.toFixed(2).padStart(9)}`)
  rows.push({ L, atClose, a, o, interest: book.interest })
}
const pick = (L: number, c: boolean) => rows.find(r => r.L === L && r.atClose === c)
const o18 = pick(1.8, false), c18 = pick(1.8, true)
console.log(`\nSell at close vs next open, at 1.8x: ${c18.a.cagr > o18.a.cagr && c18.a.mdd <= o18.a.mdd + 1 ? 'CLOSE wins' : 'OPEN wins or no real difference'} (${c18.a.cagr.toFixed(1)}% / -${c18.a.mdd.toFixed(1)}% vs ${o18.a.cagr.toFixed(1)}% / -${o18.a.mdd.toFixed(1)}%). Note: "at close" decides on the close itself, slightly optimistic vs a real 3:55pm decision.`)
console.log(`Net interest over the period at 1.8x (cash earned minus borrowing paid): ${(100 * o18.interest).toFixed(1)}% of the starting book.`)
console.log(`Research expectation for 70% combo / 30% BTC at 1.8x: ~66%/yr, worst drop ~-37%. The live code above is the number to trust.\n`)
