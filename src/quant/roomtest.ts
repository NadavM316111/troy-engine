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

/* Troy at a given leverage, live code */
function troyAt(L: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
  for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
  P.leverage = 1.8
  return eq.slice(1).map((v, k) => v / eq[k] - 1)
}

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
console.log(`\nMAKING ROOM FOR EARNINGS DRIFT: ${iso(dates[START])} to ${iso(dates[N - 1])}, all costs. ${files} stocks, ${events.length} SEC earnings releases.`)
console.log(`Troy is run at lower leverage and the drift sleeve is added; the extra money is borrowed at 5%/yr while invested.`)
const base = troyAt(1.8), B = stats(base), Bi = stats(base, 0, cut), Bo = stats(base, cut)
const LEVS = [1.2, 1.4, 1.5, 1.6, 1.8], SIZES = [0.3, 0.5, 0.7, 1.0]
const troys = new Map<number, number[]>(LEVS.map(L => [L, L === 1.8 ? base : troyAt(L)]))
const H = `${'setup'.padEnd(40)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'IS drop'.padStart(9)}${'OOS/yr'.padStart(9)}${'OOS drop'.padStart(10)}`
type Row = { label: string; a: ReturnType<typeof stats>; i: ReturnType<typeof stats>; o: ReturnType<typeof stats> }
const line = (x: Row) => console.log(`${x.label.padEnd(40)}${(x.a.day.toFixed(3) + '%').padStart(9)}${(x.a.cagr.toFixed(1) + '%').padStart(10)}${(x.a.vol.toFixed(1) + '%').padStart(12)}${x.a.sh.toFixed(2).padStart(8)}${x.i.sh.toFixed(2).padStart(8)}${x.o.sh.toFixed(2).padStart(9)}${('-' + x.a.mdd.toFixed(1) + '%').padStart(12)}${('-' + x.i.mdd.toFixed(1) + '%').padStart(9)}${(x.o.cagr.toFixed(1) + '%').padStart(9)}${('-' + x.o.mdd.toFixed(1) + '%').padStart(10)}`)
const today: Row = { label: 'Troy today (1.8x, no drift)', a: B, i: Bi, o: Bo }
for (const [X, Hd] of [[0.03, 20], [0.03, 60]] as [number, number][]) {
  const sl = sleeve(X, Hd)
  const rows: Row[] = []
  for (const L of LEVS) for (const k of SIZES) {
    const tr = troys.get(L)!
    const r = tr.map((x, d) => x + k * (sl.r[d] - sl.inv[d] * 0.05 / 252))
    rows.push({ label: `Troy ${L}x + drift ${k}x`, a: stats(r), i: stats(r, 0, cut), o: stats(r, cut) })
  }
  console.log(`\nDRIFT SLEEVE: +${X * 100}% earnings-day jump, ${Hd}-day hold`)
  console.log(H); console.log('-'.repeat(H.length)); line(today)
  // the fair pick: best Sharpe on 2017-2023 among mixes whose 2017-2023 drop is no bigger than today's
  const fair = rows.filter(x => x.i.mdd <= Bi.mdd + 0.5).sort((a, b) => b.i.sh - a.i.sh)
  console.log('-- top 6 mixes with a 2017-2023 drop no bigger than today (ranked on 2017-2023 Sharpe) --')
  for (const x of fair.slice(0, 6)) line(x)
  const ret = rows.filter(x => x.i.mdd <= Bi.mdd + 0.5).sort((a, b) => b.i.day - a.i.day)[0]
  console.log('-- most profit with a 2017-2023 drop no bigger than today --'); if (ret) line(ret)
  const p = fair[0]
  if (p) {
    const good = p.i.sh > Bi.sh + 0.05 && p.o.sh > Bo.sh && p.a.mdd <= B.mdd + 2
    console.log(`Pick: ${p.label}. Sharpe ${p.a.sh.toFixed(2)} vs ${B.sh.toFixed(2)} (2017-23 ${p.i.sh.toFixed(2)} vs ${Bi.sh.toFixed(2)}, 2024-26 ${p.o.sh.toFixed(2)} vs ${Bo.sh.toFixed(2)}), ${p.a.day.toFixed(3)}%/day vs ${B.day.toFixed(3)}%, worst drop -${p.a.mdd.toFixed(1)}% vs -${B.mdd.toFixed(1)}%.`)
    console.log(good ? 'VERDICT: clean improvement: higher Sharpe in both periods without a bigger drop.' : 'VERDICT: not a clean improvement.')
  }
}
console.log('')
