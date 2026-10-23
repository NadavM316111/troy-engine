/* npm run q:extremes   TROY's single best and worst trades and days (live code, 1.8x, all costs). */
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

const book = newBook(1_000_000, dates[START], 'TROY'); const eq: number[] = []; const tr: SwingTrade[] = []; let n = 0
const btcTrips: { start: number; end: number; pnl: number; bought: number }[] = []; let trip: { start: number; pnl: number; bought: number } | null = null
for (let t = START; t < N; t++) {
  const d = dates[t]
  for (const f of execute(book, S, d, () => String(++n), {})) {
    tr.push(f)
    if (f.leg === 'BTC') {
      if (f.action === 'BUY') { if (!trip) trip = { start: d, pnl: 0, bought: 0 }; trip.pnl -= f.total; trip.bought += f.total }
      else if (trip) { trip.pnl += f.total; if (!book.btc) { btcTrips.push({ ...trip, end: d }); trip = null } }
    }
  }
  eq.push(markEquity(book, S, d, { btcDay: d - 1 }))
  if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
}
const sells = tr.filter(x => x.action === 'SELL' && x.leg !== 'BTC' && !x.reason.startsWith('trim')).map(x => ({ ...x, entry: (() => { const s = S[x.sym]; const i = s.idx.get(x.day) ?? 0; return s.days[Math.max(0, i - (x.holdDays ?? 0))] })() }))
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`
const money = (x: number) => `${x < 0 ? '-' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`
const show = (title: string, rows: typeof sells) => { console.log(`\n${title}`); for (const x of rows) console.log(`  ${x.sym.padEnd(6)} ${x.leg.padEnd(9)} ${pct(x.net ?? 0).padStart(8)}  ${money(x.pnl ?? 0).padStart(12)}  bought ${iso(x.entry)}, sold ${iso(x.day)} (${x.holdDays} days)  ${x.reason}`) }
console.log(`\nTROY EXTREMES: live code, ${P.leverage}x, all costs, $1,000,000 start on ${iso(dates[START])}. Dollar figures are at the book size of that time.`)
show('BIGGEST WINNING STOCK TRADES', [...sells].sort((a, b) => (b.net ?? 0) - (a.net ?? 0)).slice(0, 5))
show('BIGGEST LOSING STOCK TRADES', [...sells].sort((a, b) => (a.net ?? 0) - (b.net ?? 0)).slice(0, 5))
const bt = btcTrips.map(r => ({ ...r, ret: r.pnl / Math.max(1, r.bought) }))
console.log(`\nBITCOIN: best stretch ${pct(Math.max(...bt.map(r => r.ret)))} (${iso(bt.reduce((a, b) => b.ret > a.ret ? b : a).start)} to ${iso(bt.reduce((a, b) => b.ret > a.ret ? b : a).end)}), worst stretch ${pct(Math.min(...bt.map(r => r.ret)))} (${iso(bt.reduce((a, b) => b.ret < a.ret ? b : a).start)} to ${iso(bt.reduce((a, b) => b.ret < a.ret ? b : a).end)})`)
const days = eq.slice(1).map((v, k) => ({ d: dates[START + k + 1], r: v / eq[k] - 1, usd: v - eq[k] }))
const top = (arr: typeof days, f: (a: typeof days[number], b: typeof days[number]) => number) => [...arr].sort(f).slice(0, 5)
console.log(`\nBEST DAYS FOR THE WHOLE BOOK`); for (const x of top(days, (a, b) => b.r - a.r)) console.log(`  ${iso(x.d)}  ${pct(x.r).padStart(8)}  ${money(x.usd).padStart(14)}`)
console.log(`\nWORST DAYS FOR THE WHOLE BOOK`); for (const x of top(days, (a, b) => a.r - b.r)) console.log(`  ${iso(x.d)}  ${pct(x.r).padStart(8)}  ${money(x.usd).padStart(14)}`)
const up = days.filter(x => x.r > 0).length
console.log(`\nUp days: ${(100 * up / days.length).toFixed(0)}%. Average up day ${pct(days.filter(x => x.r > 0).reduce((a, x) => a + x.r, 0) / up)}, average down day ${pct(days.filter(x => x.r <= 0).reduce((a, x) => a + x.r, 0) / (days.length - up))}.\n`)
