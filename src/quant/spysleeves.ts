/* ═══════════════════════════════════════════════════════════════════════════
   SPYSLEEVES - can an index sleeve lift TROY's Sharpe the way Bitcoin did?

     npm run q:spysleeves

   Three classic index edges, built on SPY/QQQ daily bars:
     OVERNIGHT   hold SPY from each close to the next open, flat during the day
     TURN-OF-MONTH  hold SPY from the close 2 days before month end to the close
                    of the 3rd trading day of the new month
     INDEX DIP   SPY and QQQ (half each): buy next open when RSI(2) < 10 and the
                 index is above its 200-day average, sell next open after it
                 closes above its 5-day average (or after 10 days)
   Each is scored alone, then added ON TOP of the live TROY book (1.8x, all
   costs) at 0.5x or 1x, paying 5%/yr on the extra money while invested.
   Ranked on 2017-2023, checked on 2024-2026.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)

/* Troy's daily returns, live code */
const P = PROFILES.TROY; P.leverage = 1.8; P.exitAtClose = false
const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }
const troy = eq.slice(1).map((v, k) => v / eq[k] - 1)            // troy[k] = return on day START+k+1

/* sleeve daily returns on the same days, plus a 0/1 "invested" flag; cost per side in decimals */
function overnight(cost: number) {
  const s = S['SPY'], r: number[] = [], inv: number[] = []
  for (let t = START + 1; t < N; t++) { const i = s.idx.get(dates[t])!; r.push(s.o[i] / s.c[i - 1] - 1 - 2 * cost); inv.push(1) }
  return { r, inv }
}
function turnOfMonth(cost: number) {
  const s = S['SPY'], ym = (d: number) => iso(d).slice(0, 7)
  const pos = dates.map((d, t) => { // trading-day position within month: -k from the end, +k from the start
    let a = 0; while (t - a - 1 >= 0 && ym(dates[t - a - 1]) === ym(d)) a++
    let b = 0; while (t + b + 1 < N && ym(dates[t + b + 1]) === ym(d)) b++
    return { fromStart: a + 1, fromEnd: b }
  })
  const held = (t: number) => pos[t].fromEnd <= 1 || pos[t].fromStart <= 3   // last 2 days + first 3 days
  const r: number[] = [], inv: number[] = []
  for (let t = START + 1; t < N; t++) {
    const i = s.idx.get(dates[t])!
    const wasIn = held(t - 1) && !(pos[t - 1].fromStart === 3)   // in position over day t if we held at the close of t-1
    const enter = !held(t - 2 >= 0 ? t - 2 : 0) && wasIn, exit = wasIn && pos[t].fromStart === 3
    let x = wasIn ? s.c[i] / s.c[i - 1] - 1 : 0
    if (enter) x -= cost; if (exit) x -= cost
    r.push(x); inv.push(wasIn ? 1 : 0)
  }
  return { r, inv }
}
function indexDip(cost: number) {
  const out = { r: new Array(N - START - 1).fill(0), inv: new Array(N - START - 1).fill(0) }
  for (const sym of ['SPY', 'QQQ']) {
    const s = S[sym]; let inPos = false, entry = 0, held = 0, pendIn = false, pendOut = false
    for (let t = START + 1; t < N; t++) {
      const i = s.idx.get(dates[t]); if (i === undefined) continue
      let x = 0
      if (pendIn) { inPos = true; held = 0; x += (s.c[i] / s.o[i] - 1) - cost; pendIn = false }
      else if (pendOut) { inPos = false; x += (s.o[i] / s.c[i - 1] - 1) - cost; pendOut = false }
      else if (inPos) x += s.c[i] / s.c[i - 1] - 1
      if (inPos) held++
      let m5 = 0; for (let k = i - 4; k <= i; k++) m5 += s.c[k]; m5 /= 5
      if (inPos && (s.c[i] > m5 || held >= 10)) pendOut = true
      if (!inPos && !pendIn && s.rsi2[i] < 10 && s.c[i] > s.sma200[i]) pendIn = true
      out.r[t - START - 1] += 0.5 * x; out.inv[t - START - 1] += inPos || pendOut ? 0.5 : 0
    }
  }
  return out
}
function stats(r: number[], a = 0, b = r.length) {
  const x = r.slice(a, b); let v = 1, pk = 1, m = 0; for (const y of x) { v *= 1 + y; pk = Math.max(pk, v); m = Math.max(m, 1 - v / pk) }
  const mu = x.reduce((p, q) => p + q, 0) / x.length, sd = Math.sqrt(x.reduce((p, q) => p + (q - mu) ** 2, 0) / (x.length - 1))
  return { cagr: 100 * (Math.pow(v, 252 / x.length) - 1), day: 100 * (Math.pow(v, 1 / x.length) - 1), vol: 100 * sd * Math.sqrt(252), sh: sd > 0 ? mu / sd * Math.sqrt(252) : 0, mdd: 100 * m }
}
const corr = (a: number[], b: number[]) => { const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 } return c / Math.sqrt(va * vb) }
const cut = SPLIT - START - 1

console.log(`\nINDEX SLEEVES vs TROY: ${iso(dates[START])} to ${iso(dates[N - 1])}. IS = to ${iso(dates[SPLIT])}, OOS = after.\n`)
console.log(`ON THEIR OWN (1x, no leverage)`)
const H1 = `${'sleeve'.padEnd(30)}${'cost/side'.padStart(10)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'invested'.padStart(10)}${'corr w/ Troy'.padStart(14)}`
console.log(H1); console.log('-'.repeat(H1.length))
const T = stats(troy)
console.log(`${'Troy today (1.8x)'.padEnd(30)}${''.padStart(10)}${(T.cagr.toFixed(1) + '%').padStart(10)}${(T.vol.toFixed(1) + '%').padStart(12)}${T.sh.toFixed(2).padStart(8)}${stats(troy, cut).sh.toFixed(2).padStart(9)}${('-' + T.mdd.toFixed(1) + '%').padStart(12)}`)
const builders: [string, (c: number) => { r: number[]; inv: number[] }][] = [['Overnight (SPY)', overnight], ['Turn-of-month (SPY)', turnOfMonth], ['Index dip (SPY+QQQ)', indexDip]]
const sleeves: Record<string, { r: number[]; inv: number[] }> = {}
for (const [name, f] of builders) for (const c of [0.0001, 0.0005]) {
  const x = f(c); if (c === 0.0002 || c === 0.0001) sleeves[name] = f(0.0002)
  const s = stats(x.r), o = stats(x.r, cut)
  console.log(`${name.padEnd(30)}${((c * 1e4).toFixed(0) + 'bp').padStart(10)}${(s.cagr.toFixed(1) + '%').padStart(10)}${(s.vol.toFixed(1) + '%').padStart(12)}${s.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + s.mdd.toFixed(1) + '%').padStart(12)}${((100 * x.inv.reduce((a, b) => a + b, 0) / x.inv.length).toFixed(0) + '%').padStart(10)}${corr(x.r, troy).toFixed(2).padStart(14)}`)
}
console.log(`(1bp = realistic for SPY/QQQ with market-on-open/close orders; 5bp = Troy's normal stock cost. Blends below use 2bp.)`)

console.log(`\nADDED ON TOP OF TROY (extra money borrowed at 5%/yr while the sleeve is invested)`)
const H2 = `${'setup'.padEnd(44)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'OOS/yr'.padStart(9)}`
console.log(H2); console.log('-'.repeat(H2.length))
const row = (label: string, r: number[]) => { const a = stats(r), i = stats(r, 0, cut), o = stats(r, cut); console.log(`${label.padEnd(44)}${(a.day.toFixed(3) + '%').padStart(9)}${(a.cagr.toFixed(1) + '%').padStart(10)}${(a.vol.toFixed(1) + '%').padStart(12)}${a.sh.toFixed(2).padStart(8)}${i.sh.toFixed(2).padStart(8)}${o.sh.toFixed(2).padStart(9)}${('-' + a.mdd.toFixed(1) + '%').padStart(12)}${(o.cagr.toFixed(1) + '%').padStart(9)}`); return { label, i, o, a } }
const base = row('Troy today', troy)
const out: ReturnType<typeof row>[] = []
const names = Object.keys(sleeves)
const combos: [string, string[]][] = [...names.map(nm => [nm, [nm]] as [string, string[]]), ['all three', names]]
for (const [label, parts] of combos) for (const k of [0.5, 1]) {
  const r = troy.map((x, d) => x + parts.reduce((s, nm) => s + k * (sleeves[nm].r[d] - sleeves[nm].inv[d] * 0.05 / 252), 0) / (parts.length > 1 ? parts.length : 1))
  out.push(row(`Troy + ${label} at ${k}x`, r))
}
const best = [...out].sort((a, b) => b.i.sh - a.i.sh)[0]
const ok = best.i.sh > base.i.sh + 0.05 && best.o.sh > base.o.sh
console.log(`\nBest on 2017-2023: ${best.label} -> Sharpe ${best.a.sh.toFixed(2)} (Troy ${base.a.sh.toFixed(2)}), IS ${best.i.sh.toFixed(2)} vs ${base.i.sh.toFixed(2)}, OOS ${best.o.sh.toFixed(2)} vs ${base.o.sh.toFixed(2)}.`)
console.log(ok ? `VERDICT: real improvement, better before 2024 AND after.` : `VERDICT: no sleeve clearly lifts Troy in both periods.`)
console.log('')
