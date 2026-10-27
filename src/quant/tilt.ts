/* ═══════════════════════════════════════════════════════════════════════════
   TILT - Tom's idea: lean the stock/Bitcoin split toward whichever side is
   trending, instead of a fixed 70/30. Live Troy (1.6x + earnings drift 0.6x),
   real engine, all costs, 9 years. Picked on 2017-2023, checked on 2024-2026.

     npm run q:tilt              (needs q:earnings-fetch once)

   rel63 / rel21  Bitcoin's 63- or 21-day return vs SPY's: the leader gets the bigger share
   trend          each side's own trend: lo when only stocks trend, hi when only Bitcoin
                  trends, the normal 30% otherwise
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
if (!Object.keys(ev).length) { console.log('No earnings data. Run: npm run q:earnings-fetch'); process.exit(0) }
setEarnings(ev)

type Tilt = { mode: 'rel63' | 'rel21' | 'trend'; lo: number; hi: number } | undefined
function run(t: Tilt) {
  const P = PROFILES.TROY; P.leverage = 1.6; P.exitAtClose = false; P.earnDrift = { jump: 0.03, hold: 20, weight: 0.6, slots: 10 }; P.btcTilt = t
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0, btcShare = 0
  for (let t2 = START; t2 < N; t2++) { const d = dates[t2]; execute(book, S, d, () => String(++n), {}); const e = markEquity(book, S, d, { btcDay: d - 1 }); eq.push(e); btcShare += book.btc ? book.btc.units * (book.btc.lastPx ?? 0) / e : 0; if (t2 < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  P.btcTilt = undefined
  return { eq, btcAvg: 100 * btcShare / eq.length }
}
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1), sh: mu / sd * Math.sqrt(252), mdd: 100 * m, vol: 100 * sd * Math.sqrt(252) }
}
const cut = SPLIT - START
const cfgs: [string, Tilt][] = [['Troy today (fixed 70/30)', undefined],
  ['tilt by 3-month leader, 15-45%', { mode: 'rel63', lo: 0.15, hi: 0.45 }], ['tilt by 3-month leader, 20-40%', { mode: 'rel63', lo: 0.20, hi: 0.40 }],
  ['tilt by 1-month leader, 15-45%', { mode: 'rel21', lo: 0.15, hi: 0.45 }], ['tilt by 1-month leader, 20-40%', { mode: 'rel21', lo: 0.20, hi: 0.40 }],
  ['tilt by own trends, 15-45%', { mode: 'trend', lo: 0.15, hi: 0.45 }], ['tilt by own trends, 20-40%', { mode: 'trend', lo: 0.20, hi: 0.40 }]]
console.log(`\nTOM'S TILT IDEA: live Troy (1.6x + earnings drift 0.6x), ${iso(dates[START])} to ${iso(dates[N - 1])}, all costs. IS = to ${iso(dates[SPLIT])}, OOS = after.\n`)
const H = `${'setup'.padEnd(34)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'OOS/yr'.padStart(9)}${'avg BTC share'.padStart(15)}`
console.log(H); console.log('-'.repeat(H.length))
const rows = cfgs.map(([label, t]) => { const r = run(t); const a = stats(r.eq), i = stats(r.eq, 0, cut), o = stats(r.eq, cut)
  console.log(`${label.padEnd(34)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${(a.vol.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${i.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${(o.cagr.toFixed(1) + '%').padStart(9)}${(r.btcAvg.toFixed(0) + '% of book').padStart(15)}`)
  return { label, a, i, o } })
const base = rows[0], best = [...rows.slice(1)].sort((x, y) => y.i.sh - x.i.sh)[0]
const good = best.i.sh > base.i.sh + 0.05 && best.o.sh > base.o.sh && best.a.mdd <= base.a.mdd + 2
console.log(`\nBest on 2017-2023: ${best.label} -> Sharpe ${best.a.sh.toFixed(2)} vs ${base.a.sh.toFixed(2)} (2017-23 ${best.i.sh.toFixed(2)} vs ${base.i.sh.toFixed(2)}, 2024-26 ${best.o.sh.toFixed(2)} vs ${base.o.sh.toFixed(2)}), ${best.a.cagr.toFixed(1)}%/yr vs ${base.a.cagr.toFixed(1)}%, worst drop -${best.a.mdd.toFixed(1)}% vs -${base.a.mdd.toFixed(1)}%.`)
console.log(good ? 'VERDICT: real improvement (better before 2024 AND after, no bigger drop). Worth switching on.' : "VERDICT: no tilt clearly beats the fixed 70/30. Keep it as is.")
console.log('')
