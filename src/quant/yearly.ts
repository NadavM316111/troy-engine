/* npm run q:yearly   TROY year by year (live code, 1.8x, all costs), next to SPY and Bitcoin. */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const P = PROFILES.TROY; P.leverage = Number(process.argv[2] ?? 1.8); P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false

const book = newBook(1_000_000, dates[START], 'TROY'); const eq: number[] = []; let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }

const close = (sym: string, t: number) => { const s = S[sym]; if (!s) return NaN; for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= dates[t]) return s.c[k]; return NaN }
const years = new Map<string, number[]>()
eq.forEach((_, k) => { const y = iso(dates[START + k]).slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y)!.push(k) })
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`
const money = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
console.log(`\nTROY YEAR BY YEAR: live code, ${P.leverage}x, all costs, starting with $1,000,000 on ${iso(dates[START])}\n`)
console.log(`${'year'.padEnd(10)}${'Troy'.padStart(10)}${'worst drop in year'.padStart(20)}${'SPY'.padStart(10)}${'Bitcoin'.padStart(10)}${'book at year end'.padStart(20)}`)
let prevK = 0, up = 0, down = 0
for (const [y, ks] of years) {
  const a = ks[0] === 0 ? 0 : prevK, b = ks[ks.length - 1]
  const r = eq[b] / eq[a] - 1
  let pk = eq[a], m = 0; for (let k = a; k <= b; k++) { pk = Math.max(pk, eq[k]); m = Math.max(m, 1 - eq[k] / pk) }
  const partial = ks.length < 240 ? ` (${ks.length} trading days)` : ''
  console.log(`${(y + (partial ? '*' : '')).padEnd(10)}${pct(r).padStart(10)}${('-' + (100 * m).toFixed(1) + '%').padStart(20)}${pct(close('SPY', START + b) / close('SPY', START + a) - 1).padStart(10)}${pct(close('BTC-USD', START + b) / close('BTC-USD', START + a) - 1).padStart(10)}${money(eq[b]).padStart(20)}${partial}`)
  if (!partial) { if (r > 0) up++; else down++ }
  prevK = b
}
console.log(`\nFull years: ${up} up, ${down} down. * = partial year.\n`)
