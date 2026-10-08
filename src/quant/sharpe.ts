/* ═══════════════════════════════════════════════════════════════════════════
   SHARPE - push the book's efficiency as far as the data honestly allows.

     npm run q:sp500     (once: S&P 500 list + crypto/FX/bond extras, ~5 min)
     npm run q:sharpe

   The rule behind it (Grinold's "fundamental law"): efficiency grows with the
   number of INDEPENDENT bets. So this adds edges that lose at different times
   from the combo, and measures each honestly.

   Sleeves (each run at about 1x gross, signals at the close, fills next day,
   5bp per side, shorts pay a 1%/yr borrow fee):
     COMBO      live combo, 71 stocks (swing/core.ts)
     COMBO500   same rules on the S&P 500
     SHORT500   short side: downtrend + new 20-day low, cover on a 10-day high
     REV500     market-neutral weekly reversal: long the 10% biggest 5-day
                losers, short the 10% biggest winners (S&P 500)
     TRENDLS    long/short trend on 20+ assets (bonds, gold, oil, FX, EM...)
     CRYPTO     BTC/ETH/SOL while above their 100-day average

   Then: correlations, the best blend picked on 2017-2023 only, its 2024-26
   result, and a DEFLATED Sharpe: how much of the IS Sharpe is luck from trying
   thousands of blends. Only the deflated, out-of-sample number counts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, type DSeries } from '../swing/core.js'

const COST = 0.0005, BORROW = 0.05, SHORT_FEE = 0.01
const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (t: number) => new Date(dates[t] * 86400000).toISOString().slice(0, 10)
const ok = (x: number) => Number.isFinite(x)
const SP = existsSync(join(process.cwd(), 'quant', 'sp500.json')) ? (JSON.parse(readFileSync(join(process.cwd(), 'quant', 'sp500.json'), 'utf8')) as string[]).filter(s => S[s]) : []
const LIB = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const WIDE = SP.length >= 200 ? [...new Set([...SP, ...LIB])] : LIB

const cache: Record<string, Float64Array> = {}
const C = (sym: string) => { if (cache[sym]) return cache[sym]; const s = S[sym], a = new Float64Array(N).fill(NaN); if (s) { let j = 0, last = NaN; for (let t = 0; t < N; t++) { while (j < s.days.length && s.days[j] <= dates[t]) { last = s.c[j]; j++ } a[t] = last } } return cache[sym] = a }
const R = (sym: string, t: number) => { const c = C(sym); return ok(c[t]) && ok(c[t - 1]) && c[t - 1] > 0 ? c[t] / c[t - 1] - 1 : 0 }
const smaC = (sym: string, t: number, n: number) => { const c = C(sym); let x = 0; for (let k = t - n + 1; k <= t; k++) x += c[k]; return x / n }
const volC = (sym: string, t: number, n = 60) => { let m = 0; for (let k = t - n + 1; k <= t; k++) m += R(sym, k); m /= n; let v = 0; for (let k = t - n + 1; k <= t; k++) v += (R(sym, k) - m) ** 2; return Math.sqrt(v / (n - 1) * 252) }

/* weight sleeve: weights at close t earn t+1; turnover pays COST; shorts pay fee */
function weightSleeve(weightsAt: (t: number) => Record<string, number>, every = 5) {
  const r = new Float64Array(N).fill(0); let w: Record<string, number> = {}
  for (let t = START; t < N - 1; t++) {
    if ((t - START) % every === 0) { const nw = weightsAt(t); let turn = 0; for (const u of new Set([...Object.keys(w), ...Object.keys(nw)])) turn += Math.abs((nw[u] ?? 0) - (w[u] ?? 0)); r[t + 1] -= turn * COST; w = nw }
    for (const [u, x] of Object.entries(w)) { r[t + 1] += x * R(u, t + 1); if (x < 0) r[t + 1] -= -x * SHORT_FEE / 252 }
  }
  return r
}

/* event sleeve with slots, long (+1) or short (-1): decide at close, fill next open */
function eventSleeve(universe: string[], side: 1 | -1, slots: number, maxHold: number, entry: (s: DSeries, i: number) => number | null, exit: (s: DSeries, i: number) => boolean) {
  const r = new Float64Array(N).fill(0)
  type P = { sym: string; e: number; px: number; sh: number; alloc: number }
  let cash = 1, eqPrev = 1; const pos: P[] = []; let pX: P[] = [], pE: string[] = []
  const at = (sym: string, t: number) => S[sym].idx.get(dates[t])
  const val = (p: P, px: number) => p.alloc + side * p.sh * (px - p.px)
  for (let t = START; t < N; t++) {
    for (const p of pX) { const i = at(p.sym, t); const f = i !== undefined ? S[p.sym].o[i] : C(p.sym)[t - 1]; cash += val(p, f) - p.sh * f * COST; pos.splice(pos.indexOf(p), 1) }
    const eq0 = cash + pos.reduce((a, p) => a + val(p, C(p.sym)[t - 1]), 0); const slot = eq0 / slots
    for (const u of pE) { if (pos.length >= slots || cash < slot * 0.5) break; const i = at(u, t); if (i === undefined) continue; const px = S[u].o[i]; const a = Math.min(cash, slot); pos.push({ sym: u, e: t, px, sh: a / px, alloc: a }); cash -= a + a * COST }
    pX = []; pE = []
    if (side < 0) for (const p of pos) cash -= p.sh * C(p.sym)[t] * SHORT_FEE / 252
    const eq = cash + pos.reduce((a, p) => a + val(p, C(p.sym)[t]), 0)
    if (t > START) r[t] = eq / eqPrev - 1; eqPrev = eq
    if (t === N - 1) break
    for (const p of pos) { const s = S[p.sym]; const i = at(p.sym, t); if (i === undefined) continue; const e = at(p.sym, p.e) ?? i; if (i - e + 1 >= maxHold || exit(s, i)) pX.push(p) }
    const free = slots - pos.length + pX.length; if (free <= 0) continue
    const held = new Set(pos.map(p => p.sym)); const c: [string, number][] = []
    for (const u of universe) { if (held.has(u)) continue; const s = S[u]; const i = at(u, t); if (i === undefined || !ok(s.sma200[i])) continue; const sc = entry(s, i); if (sc !== null && ok(sc)) c.push([u, sc]) }
    pE = c.sort((a, b) => b[1] - a[1]).slice(0, free).map(x => x[0])
  }
  return r
}

function coreSleeve(universe: string[]) {
  const r = new Float64Array(N).fill(0); const book = newBook(1, dates[START]); let prev = 1, n = 0
  for (let t = START; t < N; t++) { execute(book, S, dates[t], () => String(++n)); const e = markEquity(book, S, dates[t]); if (t > START) r[t] = e / prev - 1; prev = e; if (t < N - 1) decide(book, S, universe, dates[t]) }
  return r
}

console.log(`\nSHARPE RESEARCH: ${iso(START)} to ${iso(N - 1)}. IS to ${iso(SPLIT)}. S&P 500 symbols with data: ${SP.length}${SP.length < 200 ? ' (not enough: run npm run q:sp500 first; wide sleeves use the 71 stocks)' : ''}.`)
const sl: Record<string, Float64Array> = {}
const t0 = performance.now()
sl.COMBO = coreSleeve(LIB)
sl.COMBO500 = coreSleeve(WIDE)
sl.SHORT500 = eventSleeve(WIDE, -1, 10, 40, (s, i) => s.c[i] < s.sma200[i] && i >= 20 && s.c[i] < Math.min(...Array.from(s.l.slice(i - 20, i))) ? -s.ret20[i] : null, (s, i) => ok(s.hh20[i]) && s.c[i] > Math.max(...Array.from(s.h.slice(i - 10, i))))
sl.REV500 = weightSleeve(t => {
  const xs = WIDE.map(u => [u, C(u)[t] / C(u)[t - 5] - 1] as [string, number]).filter(([u, x]) => ok(x) && ok(C(u)[t - 200])).sort((a, b) => a[1] - b[1])
  if (xs.length < 40) return {}
  const k = Math.max(4, Math.floor(xs.length * 0.1)); const w: Record<string, number> = {}
  for (const [u] of xs.slice(0, k)) w[u] = 0.5 / k
  for (const [u] of xs.slice(-k)) w[u] = -0.5 / k
  return w
})
const TA = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'EWJ', 'FXI', 'TLT', 'IEF', 'SHY', 'TIP', 'LQD', 'HYG', 'GLD', 'SLV', 'CPER', 'USO', 'UNG', 'DBA', 'DBC', 'VNQ', 'UUP', 'FXE', 'FXY'].filter(s => S[s])
sl.TRENDLS = weightSleeve(t => {
  const on = TA.filter(u => ok(C(u)[t - 252]) && ok(C(u)[t]))
  if (on.length < 5) return {}
  const w: Record<string, number> = {}; let g = 0
  for (const u of on) { const sgn = C(u)[t] > C(u)[t - 252] ? 1 : -1; w[u] = sgn * (0.10 / Math.max(0.03, volC(u, t))) / Math.sqrt(on.length); g += Math.abs(w[u]) }
  if (g > 2) for (const u of Object.keys(w)) w[u] *= 2 / g
  return w
})
const CR = ['BTC-USD', 'ETH-USD', 'SOL-USD'].filter(s => S[s])
sl.CRYPTO = weightSleeve(t => { const on = CR.filter(u => ok(C(u)[t - 100]) && C(u)[t] > smaC(u, t, 100)); if (!on.length) return {}; const iv = on.map(u => 1 / Math.max(0.2, volC(u, t))); const s = iv.reduce((a, b) => a + b, 0); return Object.fromEntries(on.map((u, i) => [u, iv[i] / s])) }, 1)
console.log(`(sleeves built in ${((performance.now() - t0) / 1000).toFixed(0)}s; TRENDLS uses ${TA.length} assets, CRYPTO uses ${CR.join(', ')})`)

/* ── stats ── */
const curve = (r: ArrayLike<number>, L = 1) => { const e = [1]; for (let t = START + 1; t < N; t++) { const x = L * r[t] - Math.max(0, L - 1) * BORROW / 252; e.push(Math.max(0.01, e[e.length - 1] * (1 + x))) } return e }
function st(e: number[], a = 0, b = e.length - 1) { const r: number[] = []; let pk = e[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(e[t] / e[t - 1] - 1); pk = Math.max(pk, e[t]); m = Math.max(m, 1 - e[t] / pk) } const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1)); return { cagr: 100 * (Math.pow(e[b] / e[a], 252 / (b - a)) - 1), mdd: 100 * m, sh: sd > 0 ? mu / sd * Math.sqrt(252) : 0, vol: 100 * sd * Math.sqrt(252) } }
const isN = SPLIT - START
const f = (x: number, d = 1) => x.toFixed(d), P = (s: any, n: number) => String(s).padStart(n)
const names = Object.keys(sl)

console.log(`\n1. Each sleeve alone`)
console.log(`${'sleeve'.padEnd(10)}${P('CAGR', 8)}${P('vol', 7)}${P('Sharpe', 8)}${P('maxDD', 8)}${P('IS Shp', 8)}${P('OOS Shp', 9)}`)
for (const k of names) { const e = curve(sl[k]); const a = st(e), i = st(e, 0, isN), o = st(e, isN); console.log(`${k.padEnd(10)}${P(f(a.cagr) + '%', 8)}${P(f(a.vol) + '%', 7)}${P(f(a.sh, 2), 8)}${P(f(a.mdd) + '%', 8)}${P(f(i.sh, 2), 8)}${P(f(o.sh, 2), 9)}`) }

console.log(`\n2. Correlations of daily returns`)
const corr = (a: Float64Array, b: Float64Array) => { let sa = 0, sb = 0, n = 0; for (let t = START + 1; t < N; t++) { sa += a[t]; sb += b[t]; n++ } const ma = sa / n, mb = sb / n; let c = 0, va = 0, vb = 0; for (let t = START + 1; t < N; t++) { c += (a[t] - ma) * (b[t] - mb); va += (a[t] - ma) ** 2; vb += (b[t] - mb) ** 2 } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0 }
console.log(`${''.padEnd(10)}${names.map(n => P(n, 10)).join('')}`)
for (const a of names) console.log(`${a.padEnd(10)}${names.map(b => P(f(corr(sl[a], sl[b]), 2), 10)).join('')}`)

/* 3. blend search on IS: 10% grid, max 50% per sleeve */
const blendR = (w: number[]) => { const r = new Float64Array(N).fill(0); for (let t = START + 1; t < N; t++) { let x = 0; for (let k = 0; k < names.length; k++) x += w[k] * sl[names[k]][t]; r[t] = x } return r }
const isSharpe = (r: Float64Array) => { let m = 0, n = 0; for (let t = START + 1; t <= SPLIT; t++) { m += r[t]; n++ } m /= n; let v = 0; for (let t = START + 1; t <= SPLIT; t++) v += (r[t] - m) ** 2; return m / Math.sqrt(v / (n - 1)) * Math.sqrt(252) }
let best = { sh: -Infinity, w: [] as number[] }, tried = 0
const rec = (k: number, left: number, w: number[]) => {
  if (k === names.length - 1) { if (left > 5) return; const ww = [...w, left / 10]; tried++; const sh = isSharpe(blendR(ww)); if (sh > best.sh) best = { sh, w: ww }; return }
  for (let x = 0; x <= Math.min(left, 5); x++) rec(k + 1, left - x, [...w, x / 10])
}
rec(0, 10, [])
const br = blendR(best.w), be = curve(br), ba = st(be), bi = st(be, 0, isN), bo = st(be, isN)
/* deflated Sharpe: expected best Sharpe from `tried` useless strategies, given IS length */
const yrsIS = isN / 252, seSR = Math.sqrt(1 / yrsIS)
const z = (p: number) => { const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637], b = [-8.4735109309, 23.08336743743, -21.06224101826, 3.13082909833], c = [0.3374754822726147, 0.9761690190917186, 0.1607979714918209, 0.0276438810333863, 0.0038405729373609, 0.0003951896511919, 0.0000321767881768, 0.0000002888167364, 0.0000003960315187]; const y = p - 0.5; if (Math.abs(y) < 0.42) { const r = y * y; return y * (((a[3] * r + a[2]) * r + a[1]) * r + a[0]) / ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1) } let r = p; if (y > 0) r = 1 - p; r = Math.log(-Math.log(r)); let x = c[0] + r * (c[1] + r * (c[2] + r * (c[3] + r * (c[4] + r * (c[5] + r * (c[6] + r * (c[7] + r * c[8]))))))); return y < 0 ? -x : x }
const gam = 0.5772156649, luck = seSR * ((1 - gam) * z(1 - 1 / tried) + gam * z(1 - 1 / (tried * Math.E)))
console.log(`\n3. Best blend (picked on IS from ${tried} combinations, max 50% per sleeve)`)
console.log(`   weights: ${names.map((n, k) => best.w[k] > 0 ? `${n} ${(best.w[k] * 100).toFixed(0)}%` : '').filter(Boolean).join(', ')}`)
console.log(`   Sharpe: IS ${f(bi.sh, 2)}  |  OOS ${f(bo.sh, 2)}  |  full ${f(ba.sh, 2)}.  1x: ${f(ba.cagr)}%/yr, worst drop ${f(ba.mdd)}%`)
console.log(`   Luck allowance from trying ${tried} blends: ~${f(luck, 2)}. Deflated IS Sharpe ~${f(bi.sh - luck, 2)} (a worst case: the blends overlap, so the true allowance is smaller). The OOS number is the one to trust.`)
const baseE = curve(sl.COMBO), baseA = st(baseE)
console.log(`   For reference, today's combo alone: Sharpe ${f(baseA.sh, 2)}, ${f(baseA.cagr)}%/yr, worst drop ${f(baseA.mdd)}%`)

console.log(`\n4. Leverage on the best blend`)
console.log(`${'goal'.padEnd(24)}${P('lever', 7)}${P('CAGR', 8)}${P('avg/day', 9)}${P('maxDD', 8)}${P('OOS CAGR', 10)}${P('OOS DD', 8)}`)
const show = (g: string, L: number) => { const e = curve(br, L), a = st(e), o = st(e, isN); console.log(`${g.padEnd(24)}${P(L.toFixed(2) + 'x', 7)}${P(f(a.cagr) + '%', 8)}${P(f(100 * (Math.pow(1 + a.cagr / 100, 1 / 252) - 1), 3) + '%', 9)}${P(f(a.mdd) + '%', 8)}${P(f(o.cagr) + '%', 10)}${P(f(o.mdd) + '%', 8)}`) }
let Ldd = 0.5; for (let L = 0.5; L <= 8; L += 0.05) { if (st(curve(br, L)).mdd <= 20) Ldd = L; else break }
show('max with drop <= 20%', +Ldd.toFixed(2))
let L65 = 0; for (let L = 0.5; L <= 8; L += 0.05) if (st(curve(br, L)).cagr >= 65) { L65 = L; break }
if (L65) show('0.20%/day (65%/yr)', +L65.toFixed(2)); else console.log('0.20%/day               not reachable up to 8x')
console.log(`\nSharpe 3 check: OOS Sharpe ${f(bo.sh, 2)}. ${bo.sh >= 3 ? 'Reached.' : `Gap to 3: ${f(3 - bo.sh, 2)}.`}\n`)
