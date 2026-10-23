/* ═══════════════════════════════════════════════════════════════════════════
   EARNINGS - post-earnings drift sleeve, alone and combined with TROY.

     npm run q:earnings-fetch     (once: official SEC dates, ~2 minutes)
     npm run q:earnings

   Event: an 8-K item 2.02 earnings release. Reaction day = the release day
   if it came before 4pm ET, else the next trading day. Signal: the stock
   beats SPY by at least X% on the reaction day. Trade: buy at the next open,
   hold H trading days, sell at the open. Up to 10 positions, equal size,
   0.05% per side. Grid X = 3/5/8%, H = 20/40/60 days; picked on 2017-2023,
   checked on 2024-2026. Then added on top of the live TROY book (1.8x) at
   0.5x and 1x, paying 5%/yr on the extra money while invested.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const COST = 0.0005, MAXPOS = 10

/* events -> reaction days */
type Ev = { sym: string; day: number }
const events: Ev[] = []; let files = 0
for (const sym of U) {
  const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; files++
  const s = S[sym]
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) {
    const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16)
    let d = dayNum(e.date); if (hh * 60 + mm >= 16 * 60) d += 1
    let k = s.days.findIndex(x => x >= d); if (k < 1) continue
    events.push({ sym, day: s.days[k] })
  }
}
if (!files) { console.log('No earnings data. Run: npm run q:earnings-fetch'); process.exit(0) }

/* Troy */
const P = PROFILES.TROY; P.leverage = 1.8; P.exitAtClose = false
const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
const troy = eq.slice(1).map((v, k) => v / eq[k] - 1)

/* the sleeve: daily returns (equal slots of 1/MAXPOS), invested share */
function sleeve(X: number, H: number) {
  const spy = S['SPY']
  const sig = new Map<number, string[]>()
  for (const e of events) {
    const s = S[e.sym]; const k = s.idx.get(e.day); const q = spy.idx.get(e.day); if (k === undefined || q === undefined || k < 1) continue
    const abn = (s.c[k] / s.c[k - 1] - 1) - (spy.c[q] / spy.c[q - 1] - 1)
    if (abn >= X) { const arr = sig.get(e.day) ?? []; arr.push(e.sym); sig.set(e.day, arr) }
  }
  const open: { sym: string; left: number }[] = []
  const r: number[] = [], inv: number[] = []; let trades = 0, wins = 0
  const entryPx = new Map<string, number>()
  let pending: string[] = []
  for (let t = START + 1; t < N; t++) {
    const d = dates[t]; let x = 0
    // exits at the open for positions whose time is up
    for (const p of [...open]) {
      const s = S[p.sym]; const i = s.idx.get(d); if (i === undefined) continue
      if (p.left <= 0) { x += (s.o[i] / s.c[i - 1] - 1 - COST) / MAXPOS; const ep = entryPx.get(p.sym)!; trades++; if (s.o[i] * (1 - COST) > ep * (1 + COST)) wins++; open.splice(open.indexOf(p), 1) }
      else { x += (s.c[i] / s.c[i - 1] - 1) / MAXPOS; p.left-- }
    }
    // entries at the open from yesterday's signals
    for (const sym of pending) {
      if (open.length >= MAXPOS || open.some(p => p.sym === sym)) continue
      const s = S[sym]; const i = s.idx.get(d); if (i === undefined) continue
      x += (s.c[i] / s.o[i] - 1 - COST) / MAXPOS; open.push({ sym, left: H - 1 }); entryPx.set(sym, s.o[i])
    }
    pending = sig.get(d) ?? []
    r.push(x); inv.push(open.length / MAXPOS)
  }
  return { r, inv, trades, wins }
}
function stats(r: number[], a = 0, b = r.length) {
  const x = r.slice(a, b); let v = 1, pk = 1, m = 0; for (const y of x) { v *= 1 + y; pk = Math.max(pk, v); m = Math.max(m, 1 - v / pk) }
  const mu = x.reduce((p, q) => p + q, 0) / x.length, sd = Math.sqrt(x.reduce((p, q) => p + (q - mu) ** 2, 0) / (x.length - 1))
  return { cagr: 100 * (Math.pow(v, 252 / x.length) - 1), day: 100 * (Math.pow(v, 1 / x.length) - 1), vol: 100 * sd * Math.sqrt(252), sh: sd > 0 ? mu / sd * Math.sqrt(252) : 0, mdd: 100 * m }
}
const corr = (a: number[], b: number[]) => { const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 } return c / Math.sqrt(va * vb) }
const cut = SPLIT - START - 1
const yrs = (N - START) / 252

console.log(`\nPOST-EARNINGS DRIFT vs TROY: ${iso(dates[START])} to ${iso(dates[N - 1])}. ${files} stocks with SEC earnings dates, ${events.length} earnings releases.\n`)
console.log(`THE SLEEVE ON ITS OWN (1x, 10 slots, 0.05%/side)`)
const H1 = `${'jump needed / hold'.padEnd(24)}${'trades/yr'.padStart(10)}${'win rate'.padStart(10)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'invested'.padStart(10)}${'corr w/ Troy'.padStart(14)}`
console.log(H1); console.log('-'.repeat(H1.length))
const grid: { X: number; H: number; sl: ReturnType<typeof sleeve>; i: ReturnType<typeof stats> }[] = []
for (const X of [0.03, 0.05, 0.08]) for (const H of [20, 40, 60]) {
  const sl = sleeve(X, H), a = stats(sl.r), i = stats(sl.r, 0, cut), o = stats(sl.r, cut)
  grid.push({ X, H, sl, i })
  console.log(`${`+${X * 100}% / ${H} days`.padEnd(24)}${(sl.trades / yrs).toFixed(0).padStart(10)}${((100 * sl.wins / Math.max(1, sl.trades)).toFixed(0) + '%').padStart(10)}${(a.cagr.toFixed(1) + '%').padStart(10)}${(a.vol.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${i.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${((100 * sl.inv.reduce((p, q) => p + q, 0) / sl.inv.length).toFixed(0) + '%').padStart(10)}${corr(sl.r, troy).toFixed(2).padStart(14)}`)
}
const pick = [...grid].sort((a, b) => b.i.sh - a.i.sh)[0]
console.log(`Picked on 2017-2023: +${pick.X * 100}% jump, ${pick.H}-day hold.`)

console.log(`\nADDED ON TOP OF TROY (picked sleeve; extra money borrowed at 5%/yr while invested)`)
const H2 = `${'setup'.padEnd(30)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'OOS/yr'.padStart(9)}`
console.log(H2); console.log('-'.repeat(H2.length))
const row = (label: string, r: number[]) => { const a = stats(r), i = stats(r, 0, cut), o = stats(r, cut); console.log(`${label.padEnd(30)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${(a.vol.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${i.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${(o.cagr.toFixed(1) + '%').padStart(9)}`); return { i, o, a } }
const base = row('Troy today', troy)
const outs = [0.5, 1].map(k => ({ k, r: row(`Troy + earnings drift at ${k}x`, troy.map((x, d) => x + k * (pick.sl.r[d] - pick.sl.inv[d] * 0.05 / 252))) }))
const best = outs.sort((a, b) => b.r.i.sh - a.r.i.sh)[0]
const good = best.r.i.sh > base.i.sh + 0.05 && best.r.o.sh > base.o.sh
console.log(`\nHurdle: a sleeve lifts Troy's Sharpe only if its own Sharpe beats (correlation x ${base.a.sh.toFixed(2)}) = ${(corr(pick.sl.r, troy) * base.a.sh).toFixed(2)}. This one: ${stats(pick.sl.r).sh.toFixed(2)}.`)
console.log(good ? `VERDICT: real improvement at ${best.k}x, better before 2024 AND after.` : `VERDICT: does not clearly lift Troy in both periods.`)
console.log('')
