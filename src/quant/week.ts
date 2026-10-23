/* ═══════════════════════════════════════════════════════════════════════════
   WEEK - one random week, day by day, like live Troy.

     npm run q:week                 (a random week)
     npm run q:week -- 2022-06-13   (a chosen Monday)

   Starts a fresh $1,000,000 book on the Monday's close-to-close cycle
   (decide at the close, fill at the next open), exactly as Troy launched
   live, for the NEW algorithm (1.6x + earnings drift 0.6x) and TODAY's
   (1.8x). Prints every fill and each day's value. Also shows the same
   week for a book that had already been running since 2017.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dow = (d: number) => new Date(d * 86400000).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
setEarnings(ev)

/* pick the week: the Monday given, or a random Monday with 6 trading days after it */
const mondays: number[] = []
for (let t = START + 60; t < N - 7; t++) if (new Date(dates[t] * 86400000).getUTCDay() === 1) mondays.push(t)
const arg = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
let t0 = arg ? dates.findIndex(d => d >= dayNum(arg)) : mondays[Math.floor(Math.random() * mondays.length)]
const week: number[] = []; for (let t = t0; t < N && week.length < 6; t++) week.push(t)   // decide Mon close, then 5 trading days
const fmt = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}%`

function setP(L: number, drift: number) { const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = drift ? { jump: 0.03, hold: 20, weight: drift, slots: 10 } : undefined }
function fresh(L: number, drift: number) {
  setP(L, drift)
  const book = newBook(1_000_000, dates[week[0]], 'TROY'); let n = 0
  const days: { d: number; v: number; fills: SwingTrade[]; held: number; lev: number }[] = []
  decide(book, S, U, dates[week[0]], { btcDay: dates[week[0]] - 1 }, () => String(++n))   // Monday close: first orders
  days.push({ d: dates[week[0]], v: 1_000_000, fills: [], held: 0, lev: 0 })
  for (const t of week.slice(1)) {
    const d = dates[t]; const fills = execute(book, S, d, () => String(++n), {})
    const v = markEquity(book, S, d, { btcDay: d - 1 })
    const g = book.positions.reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0) + (book.btc ? book.btc.units * (book.btc.lastPx ?? 0) : 0)
    days.push({ d, v, fills, held: book.positions.length + (book.btc ? 1 : 0), lev: g / v })
    decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
  }
  return days
}
function warm(L: number, drift: number) {
  setP(L, drift)
  const book = newBook(1, dates[START], 'TROY'); let n = 0; const eq = new Map<number, number>()
  for (let t = START; t <= week[week.length - 1]; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.set(t, markEquity(book, S, d, { btcDay: d - 1 })); decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  return week.map(t => eq.get(t)!)
}

const spy0 = S['SPY'].c[S['SPY'].idx.get(dates[week[0]])!], spy1 = S['SPY'].c[S['SPY'].idx.get(dates[week[week.length - 1]])!]
const bt = S['BTC-USD']; const bi = (d: number) => { for (let k = bt.days.length - 1; k >= 0; k--) if (bt.days[k] <= d - 1) return k; return 0 }
console.log(`\nONE-WEEK SIMULATION: week of ${iso(dates[week[1]])} (orders decided at the close on ${dow(dates[week[0]])} ${iso(dates[week[0]])}), real engine, all costs.`)
console.log(`Market that week: SPY ${pct(spy1 / spy0 - 1)}, Bitcoin ${pct(bt.c[bi(dates[week[week.length - 1]])] / bt.c[bi(dates[week[0]])] - 1)}\n`)
for (const [label, L, drift] of [['NEW TROY (1.6x + earnings drift 0.6x)', 1.6, 0.6], ["TODAY'S TROY (1.8x)", 1.8, 0]] as [string, number, number][]) {
  const days = fresh(L, drift)
  console.log(`${label}, fresh $1,000,000`)
  for (let i = 1; i < days.length; i++) {
    const x = days[i], prev = days[i - 1]
    console.log(`  ${dow(x.d)} ${iso(x.d)}   ${fmt(x.v).padStart(12)}   day ${pct(x.v / prev.v - 1).padStart(8)}   ${String(x.held).padStart(2)} holdings   leverage ${x.lev.toFixed(2)}x`)
    for (const f of x.fills) console.log(`        ${f.action.padEnd(4)} ${f.sym.padEnd(8)} ${f.leg.padEnd(8)} at ${f.sym === 'BTC-USD' ? '$' + Math.round(f.price).toLocaleString('en-US') : '$' + f.price.toFixed(2)}  ${fmt(f.total).padStart(10)}${f.pnl !== undefined ? `  ${pct(f.net ?? 0)}` : ''}  ${f.reason.slice(0, 70)}`)
  }
  const end = days[days.length - 1].v
  const w = warm(L, drift)
  console.log(`  WEEK: ${pct(end / 1_000_000 - 1)} (${end >= 1_000_000 ? '+' : '-'}${fmt(Math.abs(end - 1_000_000))})   |   a book already running since 2017 made ${pct(w[w.length - 1] / w[0] - 1)} that same week\n`)
}
