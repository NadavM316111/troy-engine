/* ═══════════════════════════════════════════════════════════════════════════
   RESEARCH - what in the tape actually predicts the next 15 / 30 / 60 minutes?

   This ignores Troy's rules entirely and asks the market directly. It is the
   step real desks do before writing a single entry rule: measure each idea's
   predictive power, out of sample, net of costs. Rules come after evidence.

     npm run q:research

   Four studies

   1. Information Coefficient (IC). At each timestamp, rank every stock by a
      feature and by its forward return, take the Spearman correlation across
      stocks, average per day, then t-test across days.
        IC > 0  high values outperform (momentum-like)
        IC < 0  high values underperform (reversal-like)
        |t| >= 3 and the SAME sign in the first 60% and last 40% of days
        is the bar for "candidate edge". Anything else is noise. With ~12
        features x 3 horizons, about 2 would pass |t| >= 2 by pure luck.

   2. Quintiles. Bucket stocks into fifths by the feature at each timestamp.
      Q5 = top 20%. Mean forward return per bucket in basis points (1bp =
      0.01%), Q5 hit rate, and Q5 after a 10bp round trip. A tradable long
      signal needs Q5 after costs > 0, not just a pretty IC.

   3. Time of day. Average 30-minute move and cross-sectional spread by
      half hour. Tells you when there is enough movement to beat costs.

   4. Take-profit / stop-loss grid. Enter at fixed times, exit at TP, SL or a
      60-minute timeout. Shows the real trade-off between win rate and money
      made, and what a 90% win rate actually costs, measured not argued.

   No lookahead: every feature at minute i uses bars 0..i only; forward
   returns use i+1 onward. Stop is checked before target inside a minute.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAll, byDay, tradingDays, type Bar } from './data.js'
import { SAFE_STOCKS } from '../rules.js'

const COST_BP = 10                  // round trip, matches 5bp per side in score.ts
const HORIZONS = [15, 30, 60]
const SAMPLE_STEP = 5               // minutes between samples
const I0 = 30, I1 = 325             // 10:00 to 14:55, so the 60-min horizon ends by 15:55
const INDEX = new Set(['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', ...SAFE_STOCKS])

/* ── load and align ── */
const all = loadAll()
const days = tradingDays(all)
const syms = Object.keys(all).filter(s => !INDEX.has(s))
interface Day { o: number; c: Float64Array; h: Float64Array; l: Float64Array; v: Float64Array; pc: number }
function align(a: (Bar | null)[], pc: number): Day | null {
  if (a.filter(Boolean).length < 300) return null
  const c = new Float64Array(390), h = new Float64Array(390), l = new Float64Array(390), v = new Float64Array(390)
  let last = a.find(Boolean)![1]
  for (let i = 0; i < 390; i++) {
    const b = a[i]
    if (b) { c[i] = b[4]; h[i] = b[2]; l[i] = b[3]; v[i] = b[5]; last = b[4] } else { c[i] = last; h[i] = last; l[i] = last; v[i] = 0 }
  }
  return { o: a.find(Boolean)![1], c, h, l, v, pc }
}
const data: Record<string, Map<number, Day>> = {}
for (const s of [...syms, 'SPY']) {
  const m = byDay(all[s]); const out = new Map<number, Day>()
  for (let di = 1; di < days.length; di++) {
    const prev = m.get(days[di - 1]), cur = m.get(days[di]); if (!prev || !cur) continue
    let pc = 0; for (let i = 389; i >= 0; i--) if (prev[i]) { pc = prev[i]![4]; break }
    const d = pc > 0 ? align(cur, pc) : null; if (d) out.set(days[di], d)
  }
  data[s] = out
}
const testDays = days.slice(1).filter(d => data['SPY'].has(d))
const split = testDays[Math.floor(testDays.length * 0.6)]

/* ── features ── */
const FEATURES = ['mom5', 'mom15', 'mom30', 'vwapDist', 'rsi14', 'emaGap', 'rvol5', 'dayChg', 'orbDist', 'rangePos', 'gap', 'vol30'] as const
type F = typeof FEATURES[number]
const DESC: Record<F, string> = {
  mom5: '5-min return', mom15: '15-min return', mom30: '30-min return',
  vwapDist: 'distance above session VWAP', rsi14: 'RSI(14) on 1-min closes', emaGap: 'EMA5 / EMA20 - 1',
  rvol5: 'last-5-min volume / day avg per minute', dayChg: 'change vs prior close (same ranking as change vs SPY)',
  orbDist: 'distance above 30-min opening range high', rangePos: 'position in day range (0 low, 1 high)',
  gap: 'opening gap', vol30: '30-min realized volatility',
}

function featuresAt(d: Day, i: number, _spy?: Day): Record<F, number> {
  const c = d.c
  let pv = 0, vv = 0, hi = -Infinity, lo = Infinity, orh = -Infinity
  for (let j = 0; j <= i; j++) { pv += c[j] * d.v[j]; vv += d.v[j]; if (d.h[j] > hi) hi = d.h[j]; if (d.l[j] < lo) lo = d.l[j]; if (j < 30 && d.h[j] > orh) orh = d.h[j] }
  const vwap = vv > 0 ? pv / vv : c[i]
  let g = 0, ls = 0; for (let j = i - 13; j <= i; j++) { const x = c[j] - c[j - 1]; if (x > 0) g += x; else ls -= x }
  const rsi = ls === 0 ? 100 : 100 - 100 / (1 + g / ls)
  const ema = (p: number) => { const k = 2 / (p + 1); let e = c[0]; for (let j = 1; j <= i; j++) e = c[j] * k + e * (1 - k); return e }
  let r5 = 0; for (let j = i - 4; j <= i; j++) r5 += d.v[j]
  const rets: number[] = []; for (let j = i - 29; j <= i; j++) rets.push(c[j] / c[j - 1] - 1)
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length
  const dayChg = c[i] / d.pc - 1
  return {
    mom5: c[i] / c[i - 5] - 1, mom15: c[i] / c[i - 15] - 1, mom30: c[i] / c[i - 30] - 1,
    vwapDist: c[i] / vwap - 1, rsi14: rsi, emaGap: ema(5) / ema(20) - 1,
    rvol5: vv > 0 ? (r5 / 5) / (vv / (i + 1)) : NaN,
    dayChg,
    orbDist: c[i] / orh - 1, rangePos: hi > lo ? (c[i] - lo) / (hi - lo) : 0.5,
    gap: d.o / d.pc - 1,
    vol30: Math.sqrt(rets.reduce((a, r) => a + (r - mu) ** 2, 0) / rets.length),
  }
}

/* ── statistics helpers ── */
function ranks(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0])
  const r = new Array(x.length)
  for (let k = 0; k < idx.length;) { let e = k; while (e + 1 < idx.length && idx[e + 1][0] === idx[k][0]) e++; for (let q = k; q <= e; q++) r[idx[q][1]] = (k + e) / 2; k = e + 1 }
  return r
}
function spearman(a: number[], b: number[]): number {
  const n = a.length; if (n < 8) return NaN
  const ra = ranks(a), rb = ranks(b)
  const ma = (n - 1) / 2
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) { const x = ra[i] - ma, y = rb[i] - ma; sab += x * y; saa += x * x; sbb += y * y }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN
}
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const sdev = (a: number[]) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN }
const tstat = (a: number[]) => a.length > 2 ? mean(a) / (sdev(a) / Math.sqrt(a.length)) : NaN

/* ── 1 + 2: IC and quintiles ── */
type Acc = { dailyIC: Map<number, number[]>; q: number[][]; qHit: number[][]; qN: number[] }
const acc: Record<string, Acc> = {}
const key = (f: F, h: number) => `${f}|${h}`
for (const f of FEATURES) for (const h of HORIZONS) acc[key(f, h)] = { dailyIC: new Map(), q: [[], [], [], [], []].map(() => [0]), qHit: [[0], [0], [0], [0], [0]], qN: [0, 0, 0, 0, 0] }
const universeMean: Record<number, number[]> = { 15: [], 30: [], 60: [] }
const todBuckets: { absMove: number[]; disp: number[] }[] = Array.from({ length: 13 }, () => ({ absMove: [], disp: [] }))
const spyUp = new Set(testDays.filter(d => { const s = data['SPY'].get(d)!; return s.c[389] > s.pc }))

for (const d of testDays) {
  const spy = data['SPY'].get(d)
  for (let i = I0; i <= I1; i += SAMPLE_STEP) {
    const rows: { f: Record<F, number>; fwd: Record<number, number> }[] = []
    for (const s of syms) {
      const day = data[s].get(d); if (!day) continue
      const fwd: Record<number, number> = {}
      for (const h of HORIZONS) fwd[h] = day.c[i + h] / day.c[i] - 1
      rows.push({ f: featuresAt(day, i, spy), fwd })
    }
    if (rows.length < 10) continue
    for (const h of HORIZONS) universeMean[h].push(mean(rows.map(r => r.fwd[h])))
    const f30 = rows.map(r => r.fwd[30])
    const b = Math.min(12, Math.floor(i / 30))
    todBuckets[b].absMove.push(mean(f30.map(Math.abs))); todBuckets[b].disp.push(sdev(f30))
    for (const f of FEATURES) {
      const ok = rows.filter(r => Number.isFinite(r.f[f]))
      if (ok.length < 10) continue
      const fx = ok.map(r => r.f[f]), fr = ranks(fx)
      for (const h of HORIZONS) {
        const a = acc[key(f, h)]
        const ic = spearman(fx, ok.map(r => r.fwd[h]))
        if (Number.isFinite(ic)) { const arr = a.dailyIC.get(d) ?? []; arr.push(ic); a.dailyIC.set(d, arr) }
        for (let k = 0; k < ok.length; k++) {
          const q = Math.min(4, Math.floor((fr[k] / ok.length) * 5))
          a.q[q][0] += ok[k].fwd[h]; a.qHit[q][0] += ok[k].fwd[h] > 0 ? 1 : 0; a.qN[q]++
        }
      }
    }
  }
}

interface ICRow { feature: F; h: number; ic: number; t: number; icIS: number; icOOS: number; icUp: number; icDown: number; qBp: number[]; spreadBp: number; q5Hit: number; q5NetBp: number; q5ExcessBp: number; verdict: string }
const icRows: ICRow[] = []
for (const f of FEATURES) for (const h of HORIZONS) {
  const a = acc[key(f, h)]
  const daily = [...a.dailyIC.entries()].map(([d, v]) => [d, mean(v)] as [number, number])
  const all = daily.map(x => x[1])
  const is = daily.filter(x => x[0] < split).map(x => x[1]), oos = daily.filter(x => x[0] >= split).map(x => x[1])
  const up = daily.filter(x => spyUp.has(x[0])).map(x => x[1]), dn = daily.filter(x => !spyUp.has(x[0])).map(x => x[1])
  const qBp = a.q.map((s, k) => a.qN[k] ? (s[0] / a.qN[k]) * 1e4 : NaN)
  const t = tstat(all), mIS = mean(is), mOOS = mean(oos)
  const um = mean(universeMean[h]) * 1e4
  const stable = Math.sign(mIS) === Math.sign(mOOS) && Math.sign(mIS) === Math.sign(mean(all))
  const verdict = Math.abs(t) >= 3 && stable ? 'CANDIDATE' : Math.abs(t) >= 2 && stable ? 'weak' : 'noise'
  icRows.push({ feature: f, h, ic: mean(all), t, icIS: mIS, icOOS: mOOS, icUp: mean(up), icDown: mean(dn), qBp, spreadBp: qBp[4] - qBp[0], q5Hit: a.qN[4] ? 100 * a.qHit[4][0] / a.qN[4] : NaN, q5NetBp: qBp[4] - COST_BP, q5ExcessBp: qBp[4] - um, verdict })
}

/* ── 4: TP / SL grid ── */
const TPS = [0.2, 0.4, 0.6, 1.0, 1.5, 2.0, 3.0], SLS = [0.2, 0.3, 0.5, 1.0, 2.0, 3.0]
const TIMEOUT = 60
function grid(select: (d: number, i: number, s: string, day: Day) => boolean) {
  const entries: { day: Day; i: number }[] = []
  for (const d of testDays) for (let i = I0; i <= I1; i += 15) for (const s of syms) { const day = data[s].get(d); if (day && select(d, i, s, day)) entries.push({ day, i }) }
  const out: { tp: number; sl: number; win: number; expBp: number; n: number }[] = []
  for (const tp of TPS) for (const sl of SLS) {
    let wins = 0, net = 0
    for (const { day, i } of entries) {
      const e = day.c[i], up = e * (1 + tp / 100), dn = e * (1 - sl / 100), end = Math.min(i + TIMEOUT, 385)
      let r = day.c[end] / e - 1
      for (let j = i + 1; j <= end; j++) { if (day.l[j] <= dn) { r = -sl / 100; break } if (day.h[j] >= up) { r = tp / 100; break } }
      if (r > 0) wins++
      net += r * 1e4 - COST_BP
    }
    out.push({ tp, sl, win: entries.length ? 100 * wins / entries.length : NaN, expBp: entries.length ? net / entries.length : NaN, n: entries.length })
  }
  return out
}
const best30 = icRows.filter(r => r.h === 30).sort((a, b) => Math.abs(b.t) - Math.abs(a.t))[0]
const sign = Math.sign(best30.ic) || 1
const thresholds = new Map<string, number>()
function topQuintileSelect(d: number, i: number, s: string, day: Day): boolean {
  const k = `${d}|${i}`
  if (!thresholds.has(k)) {
    const spy = data['SPY'].get(d)
    const vals = syms.map(x => data[x].get(d)).filter(Boolean).map(x => sign * featuresAt(x!, i, spy)[best30.feature]).filter(Number.isFinite).sort((a, b) => a - b)
    thresholds.set(k, vals[Math.floor(vals.length * 0.8)] ?? Infinity)
  }
  return sign * featuresAt(day, i, data['SPY'].get(d))[best30.feature] >= thresholds.get(k)!
}
const gridAll = grid(() => true)
const gridTop = grid(topQuintileSelect)

/* ── print ── */
const f2 = (x: number, d = 3) => Number.isFinite(x) ? x.toFixed(d) : '  -  '
const p = (s: any, n: number) => String(s).padStart(n)
console.log(`\nRESEARCH: ${testDays.length} days, ${syms.length} stocks, samples every ${SAMPLE_STEP} min from 10:00 to 14:55. IS = first 60% of days, OOS = last 40%.\n`)
for (const h of HORIZONS) {
  console.log(`── ${h}-minute forward return ──`)
  console.log(`${'feature'.padEnd(10)}${p('IC', 8)}${p('t', 7)}${p('IC_IS', 8)}${p('IC_OOS', 8)}${p('upDays', 8)}${p('dnDays', 8)}   ${'Q1..Q5 mean fwd (bp)'.padEnd(34)}${p('Q5-Q1', 7)}${p('Q5hit', 7)}${p('Q5net', 7)}  verdict`)
  for (const r of icRows.filter(r => r.h === h).sort((a, b) => Math.abs(b.t) - Math.abs(a.t)))
    console.log(`${r.feature.padEnd(10)}${p(f2(r.ic), 8)}${p(f2(r.t, 1), 7)}${p(f2(r.icIS), 8)}${p(f2(r.icOOS), 8)}${p(f2(r.icUp), 8)}${p(f2(r.icDown), 8)}   ${r.qBp.map(x => p(f2(x, 1), 6)).join('').padEnd(34)}${p(f2(r.spreadBp, 1), 7)}${p(f2(r.q5Hit, 0) + '%', 7)}${p(f2(r.q5NetBp, 1), 7)}  ${r.verdict}`)
  console.log('')
}
console.log('Feature definitions:'); for (const f of FEATURES) console.log(`  ${f.padEnd(10)} ${DESC[f]}`)

console.log(`\n── Time of day (30-min windows) ──\n${'window'.padEnd(13)}${p('avg |move| bp', 15)}${p('dispersion bp', 15)}`)
todBuckets.forEach((b, k) => { if (!b.absMove.length) return; const m = 570 + k * 30; const hh = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; console.log(`${(hh(m) + '-' + hh(m + 30)).padEnd(13)}${p(f2(mean(b.absMove) * 1e4, 1), 15)}${p(f2(mean(b.disp) * 1e4, 1), 15)}`) })

function printGrid(title: string, g: ReturnType<typeof grid>) {
  console.log(`\n── ${title} (n=${g[0]?.n ?? 0} entries, 60-min timeout, after ${COST_BP}bp) ──`)
  console.log(`win rate %          SL→ ${SLS.map(s => p(s + '%', 7)).join('')}`)
  for (const tp of TPS) console.log(`  TP ${p(tp + '%', 5)}            ${SLS.map(sl => p(f2(g.find(x => x.tp === tp && x.sl === sl)!.win, 0), 7)).join('')}`)
  console.log(`expectancy bp/trade SL→ ${SLS.map(s => p(s + '%', 7)).join('')}`)
  for (const tp of TPS) console.log(`  TP ${p(tp + '%', 5)}            ${SLS.map(sl => p(f2(g.find(x => x.tp === tp && x.sl === sl)!.expBp, 1), 7)).join('')}`)
  const best = [...g].sort((a, b) => b.expBp - a.expBp)[0]
  const ninety = g.filter(x => x.win >= 90).sort((a, b) => b.expBp - a.expBp)
  console.log(`  best expectancy: TP ${best.tp}% / SL ${best.sl}% -> ${f2(best.expBp, 1)}bp/trade at ${f2(best.win, 0)}% win`)
  console.log(ninety.length ? `  best cell with >=90% win: TP ${ninety[0].tp}% / SL ${ninety[0].sl}% -> ${f2(ninety[0].expBp, 1)}bp/trade` : `  no cell reaches a 90% win rate`)
}
printGrid('TP/SL grid: every stock, every 15 min (random-entry baseline)', gridAll)
printGrid(`TP/SL grid: top quintile of ${best30.feature} (${sign > 0 ? 'high' : 'low'} values), the strongest 30-min feature`, gridTop)

const cands = icRows.filter(r => r.verdict === 'CANDIDATE')
console.log(`\n── Verdict ──`)
console.log(cands.length ? cands.map(r => `  ${r.feature} @ ${r.h}m: IC ${f2(r.ic)} (t ${f2(r.t, 1)}), holds IS and OOS, Q5 after costs ${f2(r.q5NetBp, 1)}bp`).join('\n') : '  No feature clears |t|>=3 with a stable sign. Nothing here is a reliable edge on this sample.')
console.log(`  Remember: ${FEATURES.length * HORIZONS.length} tests were run. Expect ~${Math.round(FEATURES.length * HORIZONS.length * 0.05)} to look significant at t~2 by chance alone.`)

mkdirSync(join(process.cwd(), 'quant', 'out'), { recursive: true })
const file = join(process.cwd(), 'quant', 'out', `research-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ days: testDays.length, syms: syms.length, ic: icRows, gridAll, gridTop }, null, 1))
console.log(`\nSaved ${file}`)
