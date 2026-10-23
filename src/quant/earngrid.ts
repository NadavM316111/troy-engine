/* ═══════════════════════════════════════════════════════════════════════════
   EARNGRID - every mix of Troy leverage and earnings drift size, real engine.

     npm run q:earngrid           (needs npm run q:earnings-fetch once)

   Troy 1.5x-2.0x x earnings drift none/0.3/0.5/0.7/1.0x x hold 20/40 days.
   Keeps only mixes whose worst drop over 9 years is 35.5% or better, then
   ranks them by Sharpe and by yearly return. IS/OOS Sharpe shown so a mix
   that only shines in one period stands out.
   (shares its engine code with earnfinal.ts)

   Unlike roomtest (which blended two separate daily return streams), this runs
   ONE book through swing/core.ts: stocks, Bitcoin and EARN positions share the
   same cash, borrowing, costs and rules, exactly as live Troy would.
     A  today: 1.8x, no earnings drift
     B  1.6x + earnings drift 0.7x (jump 3%, hold 20 days, 10 slots)
     C  1.4x + earnings drift 0.7x
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000

const ev: Record<string, number[]> = {}; let releases = 0
for (const sym of U) {
  const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue
  const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) {
    let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 16 * 60) d += 1
    const k = s.days.findIndex(x => x >= d); if (k >= 1) { ev[sym].push(s.days[k]); releases++ }
  }
}
if (!releases) { console.log('No earnings data. Run: npm run q:earnings-fetch'); process.exit(0) }
setEarnings(ev)

function run(L: number, weight: number, hold: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = weight > 0 ? { jump: 0.03, hold, weight, slots: 10 } : undefined
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; const lev: number[] = []; const tr: SwingTrade[] = []; let n = 0
  for (let t = START; t < N; t++) {
    const d = dates[t]; tr.push(...execute(book, S, d, () => String(++n), {}))
    const e = markEquity(book, S, d, { btcDay: d - 1 }); eq.push(e)
    const g = book.positions.reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0) + (book.btc ? book.btc.units * (book.btc.lastPx ?? book.btc.avgPx) : 0)
    lev.push(g / e)
    if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
  }
  P.leverage = 1.8; P.earnDrift = undefined
  return { eq, lev, tr }
}
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  let seed = 9; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const dd: number[] = []; for (let k = 0; k < 2000; k++) { let v = 1, p2 = 1, mm = 0, len = 0; while (len < r.length) { const s0 = Math.floor(rnd() * (r.length - 20)); for (let j = 0; j < 20 && len < r.length; j++, len++) { v *= 1 + r[s0 + j]; p2 = Math.max(p2, v); mm = Math.max(mm, 1 - v / p2) } } dd.push(mm) }
  dd.sort((x, y) => x - y)
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1), vol: 100 * sd * Math.sqrt(252), sh: mu / sd * Math.sqrt(252), mdd: 100 * m, worstDay: 100 * Math.min(...r), mc90: 100 * dd[Math.floor(0.9 * dd.length)] }
}
const cut = SPLIT - START
type Row = { label: string; L: number; w: number; h: number; a: ReturnType<typeof stats>; i: ReturnType<typeof stats>; o: ReturnType<typeof stats>; peak: number }
const rows: Row[] = []
const t0 = Date.now()
for (const L of [1.5, 1.6, 1.7, 1.8, 1.9, 2.0]) for (const w of [0, 0.3, 0.5, 0.7, 1.0]) for (const h of w === 0 ? [0] : [20, 40]) {
  const r = run(L, w, h)
  rows.push({ label: w === 0 ? `Troy ${L.toFixed(1)}x, no drift` : `Troy ${L.toFixed(1)}x + drift ${w}x, ${h}d`, L, w, h, a: stats(r.eq), i: stats(r.eq, 0, cut), o: stats(r.eq, cut), peak: Math.max(...r.lev) })
  process.stdout.write('.')
}
console.log(` ${rows.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
const base = rows.find(x => x.L === 1.8 && x.w === 0)!
const H = `${'setup'.padEnd(32)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'MC drop'.padStart(9)}${'worst day'.padStart(11)}${'peak lev'.padStart(10)}`
const line = (x: Row, tag = '') => console.log(`${(x.label + tag).padEnd(32)}${(x.a.day.toFixed(3) + '%').padStart(9)}${(x.a.cagr.toFixed(1) + '%').padStart(10)}${(x.a.vol.toFixed(1) + '%').padStart(12)}${x.a.sh.toFixed(2).padStart(8)}${x.i.sh.toFixed(2).padStart(8)}${x.o.sh.toFixed(2).padStart(9)}${('-' + x.a.mdd.toFixed(1) + '%').padStart(12)}${('-' + x.a.mc90.toFixed(0) + '%').padStart(9)}${(x.a.worstDay.toFixed(1) + '%').padStart(11)}${(x.peak.toFixed(2) + 'x').padStart(10)}`)
const okRisk = rows.filter(x => x.a.mdd <= 35.55)
console.log(`\n${okRisk.length} of ${rows.length} mixes keep the worst drop at 35.5% or better.\n`)
console.log(H); console.log('-'.repeat(H.length))
console.log('-- today --'); line(base)
console.log('-- top 12 by SHARPE (worst drop <= 35.5%) --'); for (const x of [...okRisk].sort((a, b) => b.a.sh - a.a.sh).slice(0, 12)) line(x)
console.log('-- top 12 by YEARLY RETURN (worst drop <= 35.5%) --'); for (const x of [...okRisk].sort((a, b) => b.a.cagr - a.a.cagr).slice(0, 12)) line(x)
// a balanced pick: the highest return among the mixes within 0.02 of the best Sharpe, that also beat today's Sharpe in BOTH periods
const bestSh = Math.max(...okRisk.map(x => x.a.sh))
const both = okRisk.filter(x => x.i.sh > base.i.sh && x.o.sh > base.o.sh)
const bal = both.filter(x => x.a.sh >= bestSh - 0.02).sort((a, b) => b.a.cagr - a.a.cagr)[0] ?? both.sort((a, b) => b.a.sh - a.a.sh)[0]
console.log('-- balanced pick: near-best Sharpe, most return, beats today in both periods --'); if (bal) line(bal); else console.log('  none')
console.log(`\nFULL GRID (all ${rows.length}, sorted by Troy leverage)`); console.log(H); console.log('-'.repeat(H.length))
for (const x of rows) line(x, x.a.mdd > 35.55 ? ' *' : '')
console.log(`* = worst drop above 35.5%\n`)
