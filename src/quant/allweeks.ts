/* ═══════════════════════════════════════════════════════════════════════════
   ALLWEEKS - every week of the 9 years: does NEW Troy (1.6x + earnings drift
   0.6x, Sharpe 1.75) beat TODAY's Troy (1.8x, Sharpe 1.65)?

     npm run q:allweeks          (needs q:earnings-fetch once)

   Both books run through the real engine from Oct 2017. Each week = Friday
   close to Friday close. Split by what SPY did that week, plus months and years.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
setEarnings(ev)
function run(L: number, drift: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = drift ? { jump: 0.03, hold: 20, weight: drift, slots: 10 } : undefined
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
  for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  P.leverage = 1.8; P.earnDrift = undefined
  return eq
}
const NEW = run(1.6, 0.6), OLD = run(1.8, 0)
const spy = (k: number) => S['SPY'].c[S['SPY'].idx.get(dates[START + k])!]

/* period ends: last trading day of each week (Mon-based), month, year */
function ends(key: (d: number) => string) { const m = new Map<string, number>(); for (let k = 0; k < NEW.length; k++) m.set(key(dates[START + k]), k); return [...m.entries()] }
const wkKey = (d: number) => { const dt = new Date(d * 86400000); const mon = d - ((dt.getUTCDay() + 6) % 7); return iso(mon) }
type P = { label: string; n: number; o: number; s: number }
function periods(key: (d: number) => string): P[] { const e = ends(key); const out: P[] = []; for (let i = 1; i < e.length; i++) { const a = e[i - 1][1], b = e[i][1]; out.push({ label: e[i][0], n: NEW[b] / NEW[a] - 1, o: OLD[b] / OLD[a] - 1, s: spy(b) / spy(a) - 1 }) } return out }
const W = periods(wkKey), M = periods(d => iso(d).slice(0, 7)), Y = periods(d => iso(d).slice(0, 4))
const pct = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(d)}%`
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
function score(label: string, ps: P[]) {
  const wins = ps.filter(p => p.n > p.o + 1e-9).length, losses = ps.filter(p => p.n < p.o - 1e-9).length
  console.log(`${label.padEnd(34)}${String(ps.length).padStart(6)}${(`${(100 * wins / Math.max(1, ps.length)).toFixed(0)}%`).padStart(11)}${(`${(100 * losses / Math.max(1, ps.length)).toFixed(0)}%`).padStart(11)}${pct(avg(ps.map(p => p.n))).padStart(11)}${pct(avg(ps.map(p => p.o))).padStart(11)}${pct(avg(ps.map(p => p.n - p.o))).padStart(13)}`)
}
console.log(`\nEVERY WEEK, NEW vs TODAY: ${iso(dates[START])} to ${iso(dates[N - 1])}, real engine, all costs. New = 1.6x + earnings drift 0.6x (Sharpe 1.75), Today = 1.8x (Sharpe 1.65).\n`)
console.log(`${'periods'.padEnd(34)}${'count'.padStart(6)}${'New wins'.padStart(11)}${'Today wins'.padStart(11)}${'New avg'.padStart(11)}${'Today avg'.padStart(11)}${'avg gap'.padStart(13)}`)
console.log('-'.repeat(97))
score('ALL WEEKS', W)
score('  weeks SPY was up', W.filter(p => p.s > 0))
score('  weeks SPY was down', W.filter(p => p.s <= 0))
score('  big down weeks (SPY -3% or worse)', W.filter(p => p.s <= -0.03))
score('  big up weeks (SPY +3% or better)', W.filter(p => p.s >= 0.03))
const worstOld = [...W].sort((a, b) => a.o - b.o).slice(0, 20)
score("  Today's 20 worst weeks", worstOld)
const bestOld = [...W].sort((a, b) => b.o - a.o).slice(0, 20)
score("  Today's 20 best weeks", bestOld)
score('ALL MONTHS', M)
score('ALL YEARS (incl. partial)', Y)
console.log(`\nToday's 10 worst weeks, side by side:`)
for (const p of worstOld.slice(0, 10)) console.log(`  week of ${p.label}   Today ${pct(p.o).padStart(8)}   New ${pct(p.n).padStart(8)}   ${p.n > p.o ? 'New lost less' : 'New lost more'}   (SPY ${pct(p.s)})`)
const diffs = W.map(p => p.n - p.o).sort((a, b) => a - b)
console.log(`\nWeekly gap (New minus Today): middle ${pct(diffs[Math.floor(diffs.length / 2)])}, half of all weeks within ${pct(diffs[Math.floor(diffs.length * 0.25)])} to ${pct(diffs[Math.floor(diffs.length * 0.75)])}.`)
console.log(`End of 9 years from $1,000,000: New $${Math.round(1e6 * NEW[NEW.length - 1] / NEW[0]).toLocaleString('en-US')}, Today $${Math.round(1e6 * OLD[OLD.length - 1] / OLD[0]).toLocaleString('en-US')}.\n`)
