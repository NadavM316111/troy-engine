/* ═══════════════════════════════════════════════════════════════════════════
   EARNFINAL - TROY with the earnings drift sleeve built into the real engine.

     npm run q:earnfinal          (needs npm run q:earnings-fetch once)

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

function run(L: number, earn: boolean) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = earn ? { jump: 0.03, hold: 20, weight: 0.7, slots: 10 } : undefined
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
const yrs = (N - START) / 252
console.log(`\nTROY + EARNINGS DRIFT IN THE REAL ENGINE: ${iso(dates[START])} to ${iso(dates[N - 1])}, all costs. ${Object.keys(ev).length} stocks, ${releases} SEC earnings releases.\n`)
const H = `${'version'.padEnd(36)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'MC drop'.padStart(9)}${'worst day'.padStart(11)}${'avg lev'.padStart(9)}${'peak lev'.padStart(10)}`
console.log(H); console.log('-'.repeat(H.length))
const cut = SPLIT - START
const results: { label: string; r: ReturnType<typeof run> }[] = [['A  today (1.8x, no drift)', 1.8, false], ['B  1.6x + earnings drift 0.7x', 1.6, true], ['C  1.4x + earnings drift 0.7x', 1.4, true]].map(([l, L, e]) => ({ label: l as string, r: run(L as number, e as boolean) }))
for (const x of results) {
  const a = stats(x.r.eq), i = stats(x.r.eq, 0, cut), o = stats(x.r.eq, cut)
  console.log(`${x.label.padEnd(36)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${(a.vol.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${i.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${('-' + a.mc90.toFixed(0) + '%').padStart(9)}${(a.worstDay.toFixed(1) + '%').padStart(11)}${(x.r.lev.reduce((p, q) => p + q, 0) / x.r.lev.length).toFixed(2).padStart(8)}x${Math.max(...x.r.lev).toFixed(2).padStart(9)}x`)
}
console.log(`\n(The separate-streams estimate for B was 0.219%/day, 73.4%/yr, Sharpe 1.71, worst drop -34.9%.)`)
console.log(`\nTRADES, version B:`)
const B = results[1].r.tr.filter(t => t.action === 'SELL' && !t.reason.startsWith('trim'))
for (const leg of ['BREAKOUT', 'DIP', 'EARN', 'BTC'] as const) {
  const q = B.filter(t => t.leg === leg); if (!q.length) continue
  const w = q.filter(t => (t.net ?? 0) > 0), l = q.filter(t => (t.net ?? 0) <= 0)
  const avg = (z: SwingTrade[]) => z.length ? 100 * z.reduce((s, t) => s + (t.net ?? 0), 0) / z.length : 0
  console.log(`  ${leg.padEnd(9)} ${(q.length / yrs).toFixed(0).padStart(4)}/yr   win ${(100 * w.length / q.length).toFixed(0)}%   avg win ${avg(w).toFixed(1)}%   avg loss ${avg(l).toFixed(1)}%   avg trade ${avg(q).toFixed(2)}%`)
}
console.log('')
