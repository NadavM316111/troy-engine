/* ═══════════════════════════════════════════════════════════════════════════
   FIVEYEAR - a random 5-year stretch, fresh $1,000,000, Troy's algorithm
   (1.6x + earnings drift 0.6x), real engine, all costs.

     npm run q:fiveyear                 (a random start)
     npm run q:fiveyear -- 2019-03-04   (a chosen start)
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, LEN = 5 * 252
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const mon = (d: number) => new Date(d * 86400000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
setEarnings(ev)

const arg = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
const last = N - 1 - LEN
const t0 = arg ? Math.min(last, Math.max(START, dates.findIndex(d => d >= dayNum(arg)))) : START + Math.floor(Math.random() * (last - START + 1))
const t1 = t0 + LEN

function run(L: number, drift: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = drift ? { jump: 0.03, hold: 20, weight: drift, slots: 10 } : undefined
  const book = newBook(1_000_000, dates[t0], 'TROY'); const eq: number[] = []; const tr: SwingTrade[] = []; let n = 0
  for (let t = t0; t <= t1; t++) { const d = dates[t]; if (t > t0) tr.push(...execute(book, S, d, () => String(++n), {})); eq.push(t === t0 ? 1_000_000 : markEquity(book, S, d, { btcDay: d - 1 })); if (t < t1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  return { eq, tr }
}
function stats({ eq, tr }: ReturnType<typeof run>) {
  const r = eq.slice(1).map((v, k) => v / eq[k] - 1)
  let pk = eq[0], m = 0, pkD = 0, botD = 0, curPk = 0; eq.forEach((v, k) => { if (v > pk) { pk = v; curPk = k } if (1 - v / pk > m) { m = 1 - v / pk; pkD = curPk; botD = k } })
  const mu = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1))
  const closed = tr.filter(t => t.action === 'SELL' && !t.reason.startsWith('trim'))
  const wins = closed.filter(t => (t.net ?? 0) > 0)
  const years: { y: string; r: number }[] = []; let a = 0
  for (let k = 1; k < eq.length; k++) { const y = iso(dates[t0 + k]).slice(0, 4); if (k === eq.length - 1 || iso(dates[t0 + k + 1]).slice(0, 4) !== y) { years.push({ y, r: eq[k] / eq[a] - 1 }); a = k } }
  const best = r.reduce((b, x, k) => x > r[b] ? k : b, 0), worst = r.reduce((b, x, k) => x < r[b] ? k : b, 0)
  const legs = ['BREAKOUT', 'DIP', 'EARN', 'BTC'].map(l => ({ l, n: closed.filter(t => t.leg === l).length, w: closed.filter(t => t.leg === l && (t.net ?? 0) > 0).length }))
  return { end: eq[eq.length - 1], cagr: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 252 / r.length) - 1), day: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 1 / r.length) - 1), sh: mu / sd * Math.sqrt(252), vol: 100 * sd * Math.sqrt(252), mdd: 100 * m, pkD, botD,
    trades: closed.length, win: 100 * wins.length / Math.max(1, closed.length), years, best: { d: dates[t0 + best + 1], x: r[best] }, worst: { d: dates[t0 + worst + 1], x: r[worst] }, legs, upDays: 100 * r.filter(x => x > 0).length / r.length }
}
const p = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
const money = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
const A = stats(run(1.6, 0.6))
const spyR = S['SPY'].c[S['SPY'].idx.get(dates[t1])!] / S['SPY'].c[S['SPY'].idx.get(dates[t0])!] - 1
console.log(`\nFIVE-YEAR SIMULATION: ${mon(dates[t0])} to ${mon(dates[t1])}, Troy (1.6x + earnings drift 0.6x), fresh $1,000,000, real engine, all costs.\n`)
console.log(`  $1,000,000 became        ${money(A.end)}   (SPY over the same 5 years: ${p(100 * spyR)}, $1M -> ${money(1e6 * (1 + spyR))})`)
console.log(`  Per year / per day       ${p(A.cagr)} / ${p(A.day, 3)}`)
console.log(`  Sharpe ratio             ${A.sh.toFixed(2)}`)
console.log(`  Volatility               ${A.vol.toFixed(1)}% a year`)
console.log(`  Worst drop               -${A.mdd.toFixed(1)}%  (peak ${mon(dates[t0 + A.pkD])}, bottom ${mon(dates[t0 + A.botD])})`)
console.log(`  Best day / worst day     ${p(100 * A.best.x)} (${mon(A.best.d)}) / ${p(100 * A.worst.x)} (${mon(A.worst.d)})`)
console.log(`  Up days                  ${A.upDays.toFixed(0)}%`)
console.log(`  Closed trades            ${A.trades}, win rate ${A.win.toFixed(1)}%   (${A.legs.filter(x => x.n).map(x => `${x.l.toLowerCase()} ${x.n}, ${(100 * x.w / x.n).toFixed(0)}% won`).join(' · ')})`)
console.log(`\n  Year by year:`)
for (const y of A.years) console.log(`    ${y.y}   ${p(100 * y.r).padStart(8)}`)
console.log(`  (first and last years are partial)\n`)
