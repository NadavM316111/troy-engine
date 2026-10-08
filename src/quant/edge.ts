/* ═══════════════════════════════════════════════════════════════════════════
   EDGE - can stacking uncorrelated strategies reach 0.2-0.25% a day?

     npm run q:daily -- XLK XLF XLE XLV XLY XLP XLI XLB XLU XLRE XLC IWM EFA EEM TLT IEF LQD HYG SLV DBC USO VNQ BTC-USD
     npm run q:edge

   How the best funds actually do it: not one brilliant strategy, but several
   decent ones that lose at different times, blended into a smoother whole,
   then levered. This measures every piece of that, honestly:

   Sleeves (all long-only, signal at the close, applied to the NEXT day's
   return, 5bp cost on every change in weight):
     COMBO    the live swing combo (swing/core.ts), 71 stocks
     TREND    cross-asset trend: each of 15 asset ETFs (stocks, bonds, gold,
              silver, oil, commodities, real estate, EM, Bitcoin) is held only
              while its 12-month return is positive, sized by inverse
              volatility, rebalanced weekly. The classic "crisis alpha" edge.
     SECTOR   hold the 3 strongest S&P sector ETFs (6-month momentum) that are
              in an uptrend, rebalanced weekly
     BTC      Bitcoin while above its 100-day average, cash otherwise

   Then: correlations, blends picked on 2017-2023 only, judged on 2024-2026,
   and the leverage each blend would need to reach 65%/yr (0.2%/day) and
   88%/yr (0.25%/day), with the drawdown that comes with it.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, type DSeries } from '../swing/core.js'

const COST = 0.0005, BORROW = 0.05
const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const spy = S['SPY']; const dates = spy.days; const N = dates.length
const START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (t: number) => new Date(dates[t] * 86400000).toISOString().slice(0, 10)
const ok = (x: number) => Number.isFinite(x)

/* close-to-close return of a symbol on the SPY calendar (crypto uses its close on SPY days) */
function closeOn(sym: string, t: number): number { const s = S[sym]; if (!s) return NaN; const i = s.idx.get(dates[t]); if (i !== undefined) return s.c[i]; for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= dates[t]) return s.c[k]; return NaN }
const closes: Record<string, Float64Array> = {}
const getC = (sym: string) => { if (!closes[sym]) { const a = new Float64Array(N); for (let t = 0; t < N; t++) a[t] = closeOn(sym, t); closes[sym] = a } return closes[sym] }
const ret = (sym: string, t: number) => { const c = getC(sym); return ok(c[t]) && ok(c[t - 1]) && c[t - 1] > 0 ? c[t] / c[t - 1] - 1 : 0 }
function vol(sym: string, t: number, n = 60) { const r: number[] = []; for (let k = t - n + 1; k <= t; k++) r.push(ret(sym, k)); const m = r.reduce((a, b) => a + b, 0) / n; return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) * Math.sqrt(252) }
const sma = (sym: string, t: number, n: number) => { const c = getC(sym); let x = 0; for (let k = t - n + 1; k <= t; k++) x += c[k]; return x / n }

/* weight-based sleeve: weights(t) decided at close t, earn returns on t+1 */
function weightSleeve(universe: string[], weightsAt: (t: number) => Record<string, number>, every = 5): Float64Array {
  const r = new Float64Array(N).fill(0)
  let w: Record<string, number> = {}
  for (let t = START; t < N - 1; t++) {
    if ((t - START) % every === 0) {
      const nw = weightsAt(t)
      let turn = 0; for (const u of new Set([...Object.keys(w), ...Object.keys(nw)])) turn += Math.abs((nw[u] ?? 0) - (w[u] ?? 0))
      r[t + 1] -= turn * COST; w = nw
    }
    for (const [u, x] of Object.entries(w)) r[t + 1] += x * ret(u, t + 1)
  }
  return r
}

/* ── sleeves ── */
const TREND_U = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'LQD', 'HYG', 'GLD', 'SLV', 'DBC', 'USO', 'VNQ', 'BTC-USD'].filter(s => S[s])
const SECTOR_U = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'].filter(s => S[s])
const avail = (u: string, t: number, look: number) => ok(getC(u)[t]) && ok(getC(u)[t - look]) && getC(u)[t - look] > 0

const sleeves: Record<string, Float64Array> = {}
const notes: string[] = []

// COMBO: replay the live core at 1x
{
  const r = new Float64Array(N).fill(0)
  const book = newBook(1, dates[START])
  let prev = 1, n = 0
  const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
  for (let t = START; t < N; t++) {
    execute(book, S, dates[t], () => String(++n))
    const e = markEquity(book, S, dates[t]); r[t] = e / prev - 1; prev = e
    if (t < N - 1) decide(book, S, U, dates[t])
  }
  r[START] = 0; sleeves.COMBO = r
}
if (TREND_U.length >= 6) sleeves.TREND = weightSleeve(TREND_U, t => {
  const on = TREND_U.filter(u => avail(u, t, 252) && getC(u)[t] / getC(u)[t - 252] - 1 > 0)
  if (!on.length) return {}
  const iv = on.map(u => 1 / Math.max(0.02, vol(u, t))); const s = iv.reduce((a, b) => a + b, 0)
  return Object.fromEntries(on.map((u, i) => [u, iv[i] / s]))
}); else notes.push(`TREND skipped: only ${TREND_U.length} of its ETFs are in the data. Run the q:daily command at the top.`)
if (SECTOR_U.length >= 6) sleeves.SECTOR = weightSleeve(SECTOR_U, t => {
  const c = SECTOR_U.filter(u => avail(u, t, 200) && getC(u)[t] > sma(u, t, 200) && avail(u, t, 131)).map(u => [u, getC(u)[t - 5] / getC(u)[t - 131] - 1] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 3)
  return Object.fromEntries(c.map(([u]) => [u, 1 / 3]))
}); else notes.push(`SECTOR skipped: only ${SECTOR_U.length} sector ETFs in the data.`)
if (S['BTC-USD']) sleeves.BTC = weightSleeve(['BTC-USD'], t => avail('BTC-USD', t, 100) && getC('BTC-USD')[t] > sma('BTC-USD', t, 100) ? { 'BTC-USD': 1 } : {} as Record<string, number>, 1)
else notes.push('BTC skipped: BTC-USD not in the data.')
sleeves.SPY = (() => { const r = new Float64Array(N).fill(0); for (let t = START + 1; t < N; t++) r[t] = ret('SPY', t); return r })()

/* ── stats ── */
function curve(r: Float64Array | number[], L = 1) {
  const eq: number[] = [1]
  for (let t = START + 1; t < N; t++) { const x = L * r[t] - (L > 1 ? (L - 1) * BORROW / 252 : 0); eq.push(eq[eq.length - 1] * (1 + x)); if (eq[eq.length - 1] <= 0.01) { while (eq.length < N - START) eq.push(0.01); break } }
  return eq
}
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], mdd = 0
  for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); mdd = Math.max(mdd, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), mdd: 100 * mdd, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1), vol: 100 * sd * Math.sqrt(252) }
}
function months(eq: number[]) {
  const ends = new Map<string, number>(); for (let k = 0; k < eq.length; k++) ends.set(iso(START + k).slice(0, 7), k)
  let prev = 0, neg = 0, n = 0, worst = 0; for (const k of ends.values()) { if (k === prev) continue; const x = eq[k] / eq[prev] - 1; n++; if (x < 0) neg++; worst = Math.min(worst, x); prev = k }
  const yends = new Map<string, number>(); for (let k = 0; k < eq.length; k++) yends.set(iso(START + k).slice(0, 4), k)
  let yp = 0, yneg = 0, yn = 0; for (const k of yends.values()) { if (k === yp) continue; yn++; if (eq[k] < eq[yp]) yneg++; yp = k }
  return { negMonths: 100 * neg / n, worstMonth: 100 * worst, negYears: 100 * yneg / yn }
}
function mc(r: number[], runs = 2000, block = 20) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const n = r.length, c: number[] = [], d: number[] = []
  for (let k = 0; k < runs; k++) { let v = 1, pk = 1, m = 0, len = 0; while (len < n) { const s = Math.floor(rnd() * (n - block)); for (let j = 0; j < block && len < n; j++, len++) { v *= 1 + r[s + j]; if (v <= 0.01) v = 0.01; pk = Math.max(pk, v); m = Math.max(m, 1 - v / pk) } } c.push(100 * (Math.pow(v, 252 / n) - 1)); d.push(100 * m) }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]
  return { c5: q(c, 0.05), c50: q(c, 0.5), d50: q(d, 0.5), d90: q(d, 0.9), ruin: 100 * c.filter(x => x < -50).length / runs }
}
const isIdx = SPLIT - START
const fmt = (x: number, d = 1) => x.toFixed(d)
const P = (s: any, n: number) => String(s).padStart(n)

console.log(`\nEDGE RESEARCH: ${iso(START)} to ${iso(N - 1)}. IS = to ${iso(SPLIT)}, OOS = after. Sleeves found: ${Object.keys(sleeves).join(', ')}`)
for (const n of notes) console.log(`  NOTE: ${n}`)

/* 1. each sleeve alone */
console.log(`\n1. Each edge on its own (1x)`)
console.log(`${'sleeve'.padEnd(9)}${P('CAGR', 8)}${P('vol', 7)}${P('Sharpe', 8)}${P('maxDD', 8)}${P('IS Shp', 8)}${P('OOS Shp', 9)}${P('avg/day', 9)}${P('neg mo', 8)}${P('worst mo', 10)}`)
const names = Object.keys(sleeves)
for (const k of names) { const eq = curve(sleeves[k]); const a = stats(eq), i = stats(eq, 0, isIdx), o = stats(eq, isIdx), m = months(eq); console.log(`${k.padEnd(9)}${P(fmt(a.cagr) + '%', 8)}${P(fmt(a.vol) + '%', 7)}${P(fmt(a.sharpe, 2), 8)}${P(fmt(a.mdd) + '%', 8)}${P(fmt(i.sharpe, 2), 8)}${P(fmt(o.sharpe, 2), 9)}${P(fmt(a.day, 3) + '%', 9)}${P(fmt(m.negMonths, 0) + '%', 8)}${P(fmt(m.worstMonth) + '%', 10)}`) }

/* 2. correlations */
const strat = names.filter(n => n !== 'SPY')
console.log(`\n2. Daily return correlations (1 = always move together, 0 = unrelated, negative = opposite)`)
console.log(`${''.padEnd(9)}${names.map(n => P(n, 8)).join('')}`)
const corr = (a: Float64Array, b: Float64Array) => { let sa = 0, sb = 0, n = 0; for (let t = START + 1; t < N; t++) { sa += a[t]; sb += b[t]; n++ } const ma = sa / n, mb = sb / n; let c = 0, va = 0, vb = 0; for (let t = START + 1; t < N; t++) { c += (a[t] - ma) * (b[t] - mb); va += (a[t] - ma) ** 2; vb += (b[t] - mb) ** 2 } return c / Math.sqrt(va * vb) }
for (const a of names) console.log(`${a.padEnd(9)}${names.map(b => P(fmt(corr(sleeves[a], sleeves[b]), 2), 8)).join('')}`)

/* 3. blends: weights chosen on IS only */
const blend = (w: Record<string, number>) => { const r = new Float64Array(N).fill(0); for (let t = START + 1; t < N; t++) for (const [k, x] of Object.entries(w)) r[t] += x * sleeves[k][t]; return r }
const blends: { name: string; w: Record<string, number> }[] = []
blends.push({ name: 'COMBO only (today)', w: { COMBO: 1 } })
blends.push({ name: 'Equal weight', w: Object.fromEntries(strat.map(k => [k, 1 / strat.length])) })
{ // risk parity on IS: weight by 1 / IS volatility
  const iv = strat.map(k => 1 / Math.max(1e-6, stats(curve(sleeves[k]), 0, isIdx).vol)); const s = iv.reduce((a, b) => a + b, 0)
  blends.push({ name: 'Risk parity (IS vol)', w: Object.fromEntries(strat.map((k, i) => [k, iv[i] / s])) })
}
{ // best IS Sharpe on a 10% grid
  let best = { sh: -Infinity, w: {} as Record<string, number> }
  const rec = (i: number, left: number, cur: Record<string, number>) => {
    if (i === strat.length - 1) { const w = { ...cur, [strat[i]]: left / 10 }; const sh = stats(curve(blend(w)), 0, isIdx).sharpe; if (sh > best.sh) best = { sh, w }; return }
    for (let k = 0; k <= left; k++) rec(i + 1, left - k, { ...cur, [strat[i]]: k / 10 })
  }
  rec(0, 10, {}); blends.push({ name: 'Max IS Sharpe (10% grid)', w: best.w })
}
console.log(`\n3. Blends (weights picked on IS only). 1x, no leverage.`)
console.log(`${'blend'.padEnd(26)}${'weights'.padEnd(46)}${P('CAGR', 8)}${P('Sharpe', 8)}${P('maxDD', 8)}${P('IS Shp', 8)}${P('OOS Shp', 9)}${P('neg mo', 8)}${P('neg yr', 8)}`)
const bRes = blends.map(b => { const r = blend(b.w); const eq = curve(r); return { ...b, r, a: stats(eq), i: stats(eq, 0, isIdx), o: stats(eq, isIdx), m: months(eq) } })
for (const b of bRes) console.log(`${b.name.padEnd(26)}${Object.entries(b.w).filter(([, x]) => x > 0).map(([k, x]) => `${k} ${(100 * x).toFixed(0)}%`).join(', ').padEnd(46)}${P(fmt(b.a.cagr) + '%', 8)}${P(fmt(b.a.sharpe, 2), 8)}${P(fmt(b.a.mdd) + '%', 8)}${P(fmt(b.i.sharpe, 2), 8)}${P(fmt(b.o.sharpe, 2), 9)}${P(fmt(b.m.negMonths, 0) + '%', 8)}${P(fmt(b.m.negYears, 0) + '%', 8)}`)

/* 4. leverage to reach the targets */
console.log(`\n4. What it takes to hit the targets (leverage costs ${BORROW * 100}%/yr on the borrowed part)`)
console.log(`${'blend'.padEnd(26)}${'goal'.padEnd(24)}${P('lever', 7)}${P('CAGR', 8)}${P('avg/day', 9)}${P('maxDD', 8)}${P('worst mo', 10)}${P('neg mo', 8)}${P('neg yr', 8)}${P('MC 5% CAGR', 12)}${P('MC DD 90%', 11)}${P('MC ruin', 9)}`)
const goals: [string, (L: number, eq: number[]) => boolean][] = [
  ['keep drop <= 22%', (L, eq) => stats(eq).mdd <= 22],
  ['keep drop <= 30%', (L, eq) => stats(eq).mdd <= 30],
  ['0.20%/day (65%/yr)', (L, eq) => stats(eq).cagr >= 65],
  ['0.25%/day (88%/yr)', (L, eq) => stats(eq).cagr >= 88],
]
for (const b of bRes) {
  for (const [g, test] of goals) {
    const drop = g.startsWith('keep')
    let found = 0
    for (let L = 0.5; L <= 6.001; L += 0.05) { const ok2 = test(L, curve(b.r, L)); if (drop ? ok2 : ok2 && !found) { found = +L.toFixed(2); if (!drop) break } else if (drop && !ok2) break }
    if (!found) { console.log(`${b.name.padEnd(26)}${g.padEnd(24)}${P('n/a', 7)}  not reachable up to 6x`); continue }
    const eq = curve(b.r, found), a = stats(eq), m = months(eq)
    const lr: number[] = []; for (let t = START + 1; t < N; t++) lr.push(found * b.r[t] - (found > 1 ? (found - 1) * BORROW / 252 : 0))
    const c = mc(lr)
    console.log(`${b.name.padEnd(26)}${g.padEnd(24)}${P(found.toFixed(2) + 'x', 7)}${P(fmt(a.cagr) + '%', 8)}${P(fmt(a.day, 3) + '%', 9)}${P(fmt(a.mdd) + '%', 8)}${P(fmt(m.worstMonth) + '%', 10)}${P(fmt(m.negMonths, 0) + '%', 8)}${P(fmt(m.negYears, 0) + '%', 8)}${P(fmt(c.c5) + '%', 12)}${P(fmt(c.d90) + '%', 11)}${P(fmt(c.ruin) + '%', 9)}`)
  }
}
/* 5. Risk overlay on the best blend: leverage that shrinks when danger shows up.
   Every signal uses data up to yesterday's close and sets today's leverage. */
{
  const best = bRes[bRes.length - 1]
  const base = best.r
  const vix = S['^VIX'] ? getC('^VIX') : null
  interface O { L: number; vt: number; dd: number; reg: boolean; vx: boolean }
  const DDS: [number, number, number][] = [[0, 0, 0], [0.06, 0.20, 0.25], [0.08, 0.25, 0.25], [0.10, 0.30, 0.4]]   // start cutting, fully cut at, floor
  const run = (o: O) => {
    const r: number[] = []; let v = 1, pk = 1, prevL = 0, ewv = 0
    for (let t = START + 1; t < N; t++) {
      // leverage for day t, from information up to t-1
      let L = o.L
      if (o.vt > 0) { const rv = Math.sqrt(ewv * 252); if (rv > 0) L = Math.min(L, o.L * Math.min(1.5, (o.vt / 100) / rv)) }
      if (o.dd > 0) { const [d0, d1, fl] = DDS[o.dd]; const dd = 1 - v / pk; const k = dd <= d0 ? 1 : dd >= d1 ? fl : 1 - (1 - fl) * (dd - d0) / (d1 - d0); L = L * k }
      if (o.reg && !(getC('SPY')[t - 1] > sma('SPY', t - 1, 200))) L = Math.min(L, 1)
      if (o.vx && vix && vix[t - 1] > 30) L = Math.min(L, 1)
      const x = L * base[t] - Math.max(0, L - 1) * BORROW / 252 - Math.abs(L - prevL) * COST
      prevL = L
      r.push(x); v *= 1 + x; if (v < 0.01) v = 0.01; pk = Math.max(pk, v)
      ewv = 0.94 * ewv + 0.06 * (L > 0 ? (x / Math.max(L, 1e-9)) ** 2 * o.L ** 2 : 0)   // vol of the unlevered blend, scaled to max leverage
    }
    return r
  }
  const eqOf = (r: number[]) => { const e = [1]; for (const x of r) e.push(e[e.length - 1] * (1 + x)); return e }
  const underwater = (e: number[]) => { let pk = e[0], cur = 0, worst = 0; for (const x of e) { if (x >= pk) { pk = x; cur = 0 } else { cur++; worst = Math.max(worst, cur) } } return worst }
  const lab = (o: O) => `${o.L}x ${[o.vt && `vol${o.vt}`, o.dd && `brake${o.dd}`, o.reg && 'trend', o.vx && 'vix'].filter(Boolean).join('+') || 'fixed'}`
  const res: { o: O; a: any; i: any; oo: any; m: any; uw: number; r: number[] }[] = []
  for (const L of [1.5, 1.8, 2, 2.25, 2.5, 3]) for (const vt of [0, 20, 25, 30, 35, 40]) for (let dd = 0; dd < DDS.length; dd++) for (const reg of [false, true]) for (const vx of vix ? [false, true] : [false]) {
    const o = { L, vt, dd, reg, vx }; const r = run(o); const e = eqOf(r)
    res.push({ o, r, a: stats(e), i: stats(e, 0, isIdx), oo: stats(e, isIdx), m: months(e), uw: underwater(e) })
  }
  const naive = res.find(x => x.o.L === 1.8 && !x.o.vt && !x.o.dd && !x.o.reg && !x.o.vx)!
  console.log(`\n5. Danger switches on ${best.name} (${Object.entries(best.w).filter(([, x]) => x > 0).map(([k, x]) => `${k} ${(100 * x).toFixed(0)}%`).join(', ')}). ${res.length} setups.${vix ? '' : ' (No ^VIX data: run q:daily with ^VIX to test the fear gauge.)'}`)
  console.log(`   Picked on IS only: same or better IS growth than plain 1.8x, then the smallest IS drop. Underwater = longest stretch below a previous peak, in trading days.`)
  console.log(`${'setup'.padEnd(30)}${P('CAGR', 8)}${P('avg/day', 9)}${P('maxDD', 8)}${P('worst mo', 10)}${P('neg yr', 8)}${P('underwater', 12)}${P('IS CAGR', 9)}${P('IS DD', 8)}${P('OOS CAGR', 10)}${P('OOS DD', 8)}${P('MC 5% CAGR', 12)}${P('MC DD 90%', 11)}`)
  const row = (x: typeof res[number]) => { const c = mc(x.r); console.log(`${lab(x.o).padEnd(30)}${P(fmt(x.a.cagr) + '%', 8)}${P(fmt(x.a.day, 3) + '%', 9)}${P(fmt(x.a.mdd) + '%', 8)}${P(fmt(x.m.worstMonth) + '%', 10)}${P(fmt(x.m.negYears, 0) + '%', 8)}${P(x.uw, 12)}${P(fmt(x.i.cagr) + '%', 9)}${P(fmt(x.i.mdd) + '%', 8)}${P(fmt(x.oo.cagr) + '%', 10)}${P(fmt(x.oo.mdd) + '%', 8)}${P(fmt(c.c5) + '%', 12)}${P(fmt(c.d90) + '%', 11)}`) }
  console.log('-- plain leverage, no switches --'); row(naive)
  const keep = res.filter(x => x.i.cagr >= naive.i.cagr * 0.97).sort((a, b) => a.i.mdd - b.i.mdd).slice(0, 8)
  console.log('-- best 8: same IS growth as plain 1.8x, smallest IS drop --'); for (const x of keep) row(x)
  const g20 = res.filter(x => x.a.cagr >= 65).sort((a, b) => a.a.mdd - b.a.mdd).slice(0, 5)
  console.log('-- for reference: smallest full-period drop among setups at 0.20%/day+ (chosen with hindsight, check OOS) --'); for (const x of g20) row(x)
  const nb = keep[0]; if (nb) {
    console.log(`\n   Neighbor check on ${lab(nb.o)} (vary leverage, same switches):`)
    console.log('   ' + res.filter(x => x.o.vt === nb.o.vt && x.o.dd === nb.o.dd && x.o.reg === nb.o.reg && x.o.vx === nb.o.vx).sort((a, b) => a.o.L - b.o.L).map(x => `${x.o.L}x ${fmt(x.a.cagr, 0)}%/${fmt(x.a.mdd, 0)}%`).join('   '))
  }
}

/* 6. FINAL SEARCH: Bitcoin share x leverage x brake x vol control, one goal:
   ~0.20%/day with the smallest drop. Picked on IS only. */
if (sleeves.BTC) {
  const DDS6: [number, number, number][] = [[0, 0, 0], [0.06, 0.20, 0.25], [0.08, 0.25, 0.25], [0.10, 0.30, 0.4], [0.05, 0.15, 0.5], [0.08, 0.20, 0.5]]
  type O6 = { b: number; L: number; dd: number; vt: number }
  const run6 = (o: O6) => {
    const r: number[] = []; let v = 1, pk = 1, prevL = 0, ewv = 0
    for (let t = START + 1; t < N; t++) {
      const base = (1 - o.b) * sleeves.COMBO[t] + o.b * sleeves.BTC[t]
      let L = o.L
      if (o.vt > 0 && ewv > 0) L = Math.min(L, (o.vt / 100) / Math.sqrt(ewv * 252))
      if (o.dd > 0) { const [d0, d1, fl] = DDS6[o.dd]; const dd = 1 - v / pk; const k = dd <= d0 ? 1 : dd >= d1 ? fl : 1 - (1 - fl) * (dd - d0) / (d1 - d0); L *= k }
      const x = L * base - Math.max(0, L - 1) * BORROW / 252 - Math.abs(L - prevL) * COST
      prevL = L; r.push(x); v = Math.max(0.01, v * (1 + x)); pk = Math.max(pk, v)
      ewv = 0.94 * ewv + 0.06 * base * base
    }
    return r
  }
  const eqOf = (r: number[]) => { const e = [1]; for (const x of r) e.push(e[e.length - 1] * (1 + x)); return e }
  const underwater = (e: number[]) => { let pk = e[0], cur = 0, w = 0; for (const x of e) { if (x >= pk) { pk = x; cur = 0 } else { cur++; w = Math.max(w, cur) } } return w }
  const lab = (o: O6) => `BTC ${(o.b * 100).toFixed(0)}% ${o.L}x${o.dd ? ` brake${o.dd}` : ''}${o.vt ? ` vol${o.vt}` : ''}`
  const all: { o: O6; r: number[]; a: any; i: any; oo: any; m: any; uw: number }[] = []
  for (let b = 0.10; b <= 0.401; b += 0.05) for (let L = 1.5; L <= 4.001; L += 0.25) for (let dd = 0; dd < DDS6.length; dd++) for (const vt of [0, 25, 30, 35, 40, 50]) {
    const o = { b: +b.toFixed(2), L: +L.toFixed(2), dd, vt }; const r = run6(o); const e = eqOf(r)
    all.push({ o, r, a: stats(e), i: stats(e, 0, isIdx), oo: stats(e, isIdx), m: months(e), uw: underwater(e) })
  }
  const ref = all.find(x => x.o.b === 0.3 && x.o.L === 1.75 && !x.o.dd && !x.o.vt)!
  const targetIS = all.filter(x => x.o.b === 0.3 && !x.o.dd && !x.o.vt).map(x => x.i.cagr).sort((a, b) => a - b)
  const plain = all.filter(x => x.o.b === 0.3 && !x.o.dd && !x.o.vt && x.a.cagr >= 64).sort((a, b) => a.o.L - b.o.L)[0] ?? ref
  console.log(`\n6. FINAL SEARCH: ${all.length} setups (Bitcoin share 10-40%, leverage 1.5-4x, 6 brakes, 6 vol controls). Goal: ~0.20%/day, smallest drop.`)
  console.log(`   Picked on IS only: IS growth at least the plain 70/30 at ~0.20%/day (${fmt(plain.i.cagr)}% IS), then smallest IS drop.`)
  console.log(`${'setup'.padEnd(28)}${P('CAGR', 8)}${P('avg/day', 9)}${P('maxDD', 8)}${P('worst mo', 10)}${P('neg yr', 8)}${P('underwater', 12)}${P('IS CAGR', 9)}${P('IS DD', 8)}${P('OOS CAGR', 10)}${P('OOS DD', 8)}${P('MC 5% CAGR', 12)}${P('MC DD 90%', 11)}`)
  const row = (x: typeof all[number]) => { const c = mc(x.r); console.log(`${lab(x.o).padEnd(28)}${P(fmt(x.a.cagr) + '%', 8)}${P(fmt(x.a.day, 3) + '%', 9)}${P(fmt(x.a.mdd) + '%', 8)}${P(fmt(x.m.worstMonth) + '%', 10)}${P(fmt(x.m.negYears, 0) + '%', 8)}${P(x.uw, 12)}${P(fmt(x.i.cagr) + '%', 9)}${P(fmt(x.i.mdd) + '%', 8)}${P(fmt(x.oo.cagr) + '%', 10)}${P(fmt(x.oo.mdd) + '%', 8)}${P(fmt(c.c5) + '%', 12)}${P(fmt(c.d90) + '%', 11)}`) }
  console.log('-- reference: plain 70/30 at ~0.20%/day --'); row(plain)
  const picks = all.filter(x => x.i.cagr >= plain.i.cagr).sort((a, b) => a.i.mdd - b.i.mdd).slice(0, 10)
  console.log('-- best 10: same IS growth, smallest IS drop --'); for (const x of picks) row(x)
  const w = picks[0]; if (w) {
    console.log(`\n   Neighbor check on ${lab(w.o)}:`)
    console.log('   leverage: ' + all.filter(x => x.o.b === w.o.b && x.o.dd === w.o.dd && x.o.vt === w.o.vt).sort((a, b) => a.o.L - b.o.L).map(x => `${x.o.L}x ${fmt(x.a.cagr, 0)}%/${fmt(x.a.mdd, 0)}%`).join('  '))
    console.log('   BTC share: ' + all.filter(x => x.o.L === w.o.L && x.o.dd === w.o.dd && x.o.vt === w.o.vt).sort((a, b) => a.o.b - b.o.b).map(x => `${(x.o.b * 100).toFixed(0)}% ${fmt(x.a.cagr, 0)}%/${fmt(x.a.mdd, 0)}%`).join('  '))
  }
  void targetIS
}

console.log(`\nMC = 2,000 block-bootstrapped histories. "MC 5% CAGR" = a bad-luck outcome (5th percentile). "MC DD 90%" = the drop you should plan for. "MC ruin" = histories that lost more than half.`)
console.log(`Blends assume the sleeves are rebalanced to their weights daily; real rebalancing would be weekly, a small difference.\n`)
