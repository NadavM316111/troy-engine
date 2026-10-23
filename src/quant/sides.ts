/* ═══════════════════════════════════════════════════════════════════════════
   SIDES - stocks vs Bitcoin inside TROY (live code, 1.8x, all costs).

     npm run q:sides

   Splits every day's profit or loss into stocks (breakouts + dips), Bitcoin
   and interest, then scores each side: profit, trades, win rate, average win
   and loss, risk (how much it swings the book), worst day and worst drop.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const P = PROFILES.TROY; P.leverage = Number(process.argv[2] ?? 1.8); P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false

type Side = 'STOCKS' | 'BTC'
const book = newBook(1_000_000, dates[START], 'TROY'); let n = 0
const val = { STOCKS: 0, BTC: 0 }, daily: { STOCKS: number[]; BTC: number[]; INT: number[] } = { STOCKS: [], BTC: [], INT: [] }
const eqPrev: number[] = []; let prevInt = 0, prevEq = 1_000_000
const trades: SwingTrade[] = []
const btcTrips: { start: number; end: number; pnl: number; bought: number }[] = []; let trip: { start: number; pnl: number; bought: number } | null = null
for (let t = START; t < N; t++) {
  const d = dates[t]
  const fills = execute(book, S, d, () => String(++n), {})
  const flow = { STOCKS: 0, BTC: 0 }
  for (const f of fills) {
    trades.push(f)
    const side: Side = f.leg === 'BTC' ? 'BTC' : 'STOCKS'
    flow[side] += f.action === 'BUY' ? -f.total : f.total
    if (f.leg === 'BTC') {
      if (f.action === 'BUY') { if (!trip) trip = { start: t, pnl: 0, bought: 0 }; trip.pnl -= f.total; trip.bought += f.total }
      else if (trip) { trip.pnl += f.total; if (!book.btc) { btcTrips.push({ ...trip, end: t }); trip = null } }
    }
  }
  const eq = markEquity(book, S, d, { btcDay: d - 1 })
  const sv = book.positions.reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0)
  const bv = book.btc ? book.btc.units * (book.btc.lastPx ?? book.btc.avgPx) : 0
  if (t > START) {
    daily.STOCKS.push((sv - val.STOCKS + flow.STOCKS) / prevEq)
    daily.BTC.push((bv - val.BTC + flow.BTC) / prevEq)
  }
  val.STOCKS = sv; val.BTC = bv
  if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
  if (t > START) daily.INT.push(((book.interest ?? 0) - prevInt) / prevEq)
  prevInt = book.interest ?? 0; prevEq = markEquity(book, S, d, { btcDay: d - 1 })
}
if (trip) btcTrips.push({ ...trip, end: N - 1, pnl: trip.pnl + (book.btc ? book.btc.units * (book.btc.lastPx ?? 0) : 0) })

const yrs = daily.STOCKS.length / 252
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }
function cumDD(a: number[]) { let c = 0, pk = 0, m = 0; for (const x of a) { c += x; pk = Math.max(pk, c); m = Math.max(m, pk - c) } return m }
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 } return c / Math.sqrt(va * vb) }

const stockSells = trades.filter(t => t.action === 'SELL' && t.leg !== 'BTC' && !t.reason.startsWith('trim'))
const legStats = (rows: { net: number; dollars: number; days?: number }[]) => {
  const w = rows.filter(r => r.net > 0), l = rows.filter(r => r.net <= 0)
  const avg = (q: typeof rows, k: 'net' | 'dollars') => q.length ? mean(q.map(r => r[k])) : 0
  return { n: rows.length, perYr: rows.length / yrs, win: rows.length ? 100 * w.length / rows.length : 0, avgW: 100 * avg(w, 'net'), avgL: 100 * avg(l, 'net'), avgWd: avg(w, 'dollars'), avgLd: avg(l, 'dollars'), worst: rows.length ? 100 * Math.min(...rows.map(r => r.net)) : 0, hold: rows.length ? mean(rows.map(r => r.days ?? 0)) : 0 }
}
const st = legStats(stockSells.map(t => ({ net: t.net ?? 0, dollars: t.pnl ?? 0, days: t.holdDays })))
const br = legStats(stockSells.filter(t => t.leg === 'BREAKOUT').map(t => ({ net: t.net ?? 0, dollars: t.pnl ?? 0, days: t.holdDays })))
const dp = legStats(stockSells.filter(t => t.leg === 'DIP').map(t => ({ net: t.net ?? 0, dollars: t.pnl ?? 0, days: t.holdDays })))
const bt = legStats(btcTrips.map(r => ({ net: r.pnl / Math.max(1, r.bought), dollars: r.pnl, days: r.end - r.start })))

const side = (a: number[]) => ({ perYr: 100 * mean(a) * 252, vol: 100 * sd(a) * Math.sqrt(252), worstDay: 100 * Math.min(...a), dd: 100 * cumDD(a), sh: mean(a) / sd(a) * Math.sqrt(252) })
const S1 = side(daily.STOCKS), B1 = side(daily.BTC), I1 = 100 * mean(daily.INT) * 252
const varS = (S1.vol / 100) ** 2, varB = (B1.vol / 100) ** 2, cov = corr(daily.STOCKS, daily.BTC) * (S1.vol / 100) * (B1.vol / 100)
const tot = varS + varB + 2 * cov, shareS = 100 * (varS + cov) / tot, shareB = 100 * (varB + cov) / tot

const f1 = (x: number) => x.toFixed(1), p = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`
const money = (x: number) => `${x < 0 ? '-' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`
console.log(`\nSTOCKS vs BITCOIN inside TROY: live code, ${P.leverage}x, all costs, ${iso(dates[START])} to ${iso(dates[N - 1])}\n`)
const R = (l: string, a: string, b: string) => console.log(`${l.padEnd(38)}${a.padStart(16)}${b.padStart(16)}`)
R('', 'STOCKS', 'BITCOIN')
R('PROFIT', '', '')
R('  adds to Troy per year (average)', p(S1.perYr), p(B1.perYr))
R('  profit per unit of risk (Sharpe)', S1.sh.toFixed(2), B1.sh.toFixed(2))
R('RISK', '', '')
R('  swing it adds to the book per year', `${f1(S1.vol)}%`, `${f1(B1.vol)}%`)
R('  share of Troy\'s total risk', `${shareS.toFixed(0)}%`, `${shareB.toFixed(0)}%`)
R('  worst single day (share of book)', p(S1.worstDay), p(B1.worstDay))
R('  worst drop it caused (share of book)', `-${f1(S1.dd)}%`, `-${f1(B1.dd)}%`)
R('TRADES', '', '')
R('  trades per year', st.perYr.toFixed(0), bt.perYr.toFixed(1))
R('  win rate (after costs)', `${f1(st.win)}%`, `${f1(bt.win)}%`)
R('  average win', `${p(st.avgW)}`, `${p(bt.avgW)}`)
R('  average loss', `${p(st.avgL)}`, `${p(bt.avgL)}`)
R('  worst single trade', p(st.worst), p(bt.worst))
R('  average hold (trading days)', st.hold.toFixed(0), bt.hold.toFixed(0))
console.log(`\nInterest on borrowing costs Troy about ${p(I1)} a year. Stocks and Bitcoin move together only ${corr(daily.STOCKS, daily.BTC).toFixed(2)} (1 = always together, 0 = unrelated).`)
console.log(`\nInside the stocks:            ${'trades/yr'.padStart(10)}${'win rate'.padStart(10)}${'avg win'.padStart(10)}${'avg loss'.padStart(10)}${'worst'.padStart(10)}${'hold'.padStart(7)}`)
for (const [l, x] of [['  breakouts', br], ['  dips', dp]] as [string, typeof br][]) console.log(`${l.padEnd(30)}${x.perYr.toFixed(0).padStart(10)}${(f1(x.win) + '%').padStart(10)}${p(x.avgW).padStart(10)}${p(x.avgL).padStart(10)}${p(x.worst).padStart(10)}${x.hold.toFixed(0).padStart(7)}`)
console.log(`\nBitcoin "trades" are each stretch from getting in (above its 100-day average) to getting fully out (below it). Rebalances in between are part of the same trade.\n`)
