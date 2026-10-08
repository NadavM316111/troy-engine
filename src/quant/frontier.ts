/* ═══════════════════════════════════════════════════════════════════════════
   FRONTIER - how much return can the swing combo produce, for how much drop?

     npm run q:frontier

   Same entry and exit rules as the live combo (imported from swing/core.ts).
   What changes is how much money rides on them, and when it is pulled back:

     Leverage L       1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x. Borrowed money costs
                      5%/yr. Each slot = L x equity / 10.
     P1 market switch leverage only while SPY > its 200-day average, else 1x
     P2 vol control   exposure x min(1, 16% / SPY 20-day realized vol)
     P3 DD brake      book 10%+ below its peak: exposure capped at 1x until
                      it recovers to within 5% of the peak
     P4 sector cap    at most 3 open positions per sector
     P5 safe haven    in a SPY downtrend, idle cash sits in GLD

   When the allowed exposure drops (P1-P3), every position is trimmed pro rata
   at the next open, paying costs. That is what makes the protections real.

   No cheating on the pick: every setup is ranked on 2017-2023 ONLY, then the
   winners are judged on 2024-2026, which played no part in choosing them.
   The winners then face the stress tests: without the 10 biggest winners,
   double costs, the 2020 crash, 2022, and a block-bootstrap Monte Carlo.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY, sectorOf } from '../rules.js'
import { buildSeries, entryScore, exitReason, PROFILES, type DSeries, type Leg } from '../swing/core.js'
const LEGS = PROFILES.COMBO.legs

const BASE_COST = 0.0005, BORROW = 0.05 / 252, VOL_TARGET = 0.16
const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const FULL = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const spy = S['SPY'], gld = S['GLD']
const dates = spy.days, N = dates.length, START = 210, SPLIT = START + Math.floor((N - START) * 0.7)
const ok = (x: number) => Number.isFinite(x)
const dayIdx = (d: string) => { const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000; let i = 0; while (i < N - 1 && dates[i] < t) i++; return i }
const iso = (t: number) => new Date(dates[t] * 86400000).toISOString().slice(0, 10)

// SPY 20-day realized vol (annualized), known at the close
const spyVol = new Float64Array(N).fill(NaN)
for (let i = 21; i < N; i++) { const r: number[] = []; for (let k = i - 19; k <= i; k++) r.push(Math.log(spy.c[k] / spy.c[k - 1])); const m = r.reduce((a, b) => a + b, 0) / r.length; spyVol[i] = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) }

interface Cfg { L: number; p1: boolean; p2: boolean; p3: boolean; p4: boolean; p5: boolean; q: boolean }
/* q = quick-profit dips: the DIP leg sells on the first close above entry (the 75% book's exit) instead of above the 5-day average. Raises win rate. */
const label = (c: Cfg) => `${c.L}x ${[c.q && 'quickdip', c.p1 && 'switch', c.p2 && 'vol', c.p3 && 'brake', c.p4 && 'sector', c.p5 && 'gold'].filter(Boolean).join('+') || 'none'}`

interface Pos { sym: string; leg: Leg; e: number; px: number; sh: number }
function simulate(cfg: Cfg, universe: string[], costX = 1) {
  const COST = BASE_COST * costX
  let cash = 1, gldSh = 0
  const pos: Pos[] = []
  const eq = new Float64Array(N).fill(NaN)
  const rets: number[] = []
  let pendX: Pos[] = [], pendE: [string, Leg][] = [], trimTo = Infinity, peak = 1, braked = false, slotSize = 0.1
  const lastC = (s: DSeries, t: number) => { const i = s.idx.get(dates[t]); if (i !== undefined) return s.c[i]; for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= dates[t]) return s.c[k]; return NaN }
  const openPx = (s: DSeries, t: number) => { const i = s.idx.get(dates[t]); return i !== undefined ? s.o[i] : lastC(s, t - 1) }
  let equity = 1, nTrades = 0, wins = 0, curLever = cfg.L
  for (let t = START; t < N; t++) {
    // ── open: exits, trims, entries, gold ──
    for (const p of pendX) { const f = openPx(S[p.sym], t); cash += p.sh * f * (1 - COST); pos.splice(pos.indexOf(p), 1); nTrades++; if (f > p.px) wins++ }
    if (trimTo < Infinity) {
      const inv = pos.reduce((a, p) => a + p.sh * openPx(S[p.sym], t), 0)
      if (inv > trimTo * 1.02) { const k = trimTo / inv; for (const p of pos) { const f = openPx(S[p.sym], t); const sell = p.sh * (1 - k); cash += sell * f * (1 - COST); p.sh -= sell } }
    }
    if (gldSh > 0 && (pendE.length || !(cfg.p5 && spy.c[t - 1] < spy.sma200[t - 1]))) { cash += gldSh * openPx(gld, t) * (1 - COST); gldSh = 0 }
    for (const [u, leg] of pendE) {
      const L = LEGS.find(x => x.leg === leg)!
      if (pos.filter(p => p.leg === leg).length >= L.slots) continue
      const s = S[u]; const i = s.idx.get(dates[t]); if (i === undefined) continue
      const px = s.o[i]; const inv = pos.reduce((a, p) => a + p.sh * openPx(S[p.sym], t), 0)
      const room = Math.min(slotSize, Math.max(0, curLever * equity - inv) + 1e-12)
      if (room < slotSize * 0.5) break
      pos.push({ sym: u, leg, e: t, px, sh: room / (px * (1 + COST)) }); cash -= room
    }
    if (cfg.p5 && gld && spy.c[t - 1] < spy.sma200[t - 1] && cash > 0.05 * equity && gldSh === 0) { const f = openPx(gld, t); if (ok(f)) { gldSh = (cash * 0.98) / (f * (1 + COST)); cash -= cash * 0.98 } }
    pendX = []; pendE = []; trimTo = Infinity
    // ── close: interest, mark ──
    if (cash < 0) cash += cash * BORROW
    const inv = pos.reduce((a, p) => a + p.sh * lastC(S[p.sym], t), 0) + (gldSh > 0 ? gldSh * lastC(gld, t) : 0)
    const prevEq = equity
    equity = cash + inv; eq[t] = equity
    if (t > START) rets.push(equity / prevEq - 1)
    if (equity <= 0.05) { for (let k = t; k < N; k++) eq[k] = Math.max(equity, 1e-6); break }   // blown up
    peak = Math.max(peak, equity)
    if (t === N - 1) break
    // ── close: lever for tomorrow ──
    let lever = cfg.L
    if (cfg.p1 && !(spy.c[t] > spy.sma200[t])) lever = Math.min(lever, 1)
    if (cfg.p2 && ok(spyVol[t])) lever = lever * Math.min(1, VOL_TARGET / spyVol[t])
    if (cfg.p3) { const dd = 1 - equity / peak; if (dd >= 0.10) braked = true; if (dd <= 0.05) braked = false; if (braked) lever = Math.min(lever, 1) }
    curLever = lever
    slotSize = lever * equity / 10
    // exits
    for (const p of pos) {
      const s = S[p.sym]; const i = s.idx.get(dates[t]); if (i === undefined) continue
      const e = s.idx.get(dates[p.e])!; const L = LEGS.find(x => x.leg === p.leg)!
      if (i - e + 1 >= L.maxHold || exitReason(cfg.q && p.leg === 'DIP' ? 'DIP75' : p.leg, s, i, p.px)) pendX.push(p)
    }
    const keep = pos.filter(p => !pendX.includes(p))
    const keepInv = keep.reduce((a, p) => a + p.sh * lastC(S[p.sym], t), 0)
    if (keepInv > lever * equity * 1.05) trimTo = lever * equity
    // entries
    let room = Math.max(0, lever * equity - Math.min(keepInv, lever * equity))
    const held = new Set(keep.map(p => p.sym)), exiting = new Set(pendX.map(p => p.sym))
    const secCount: Record<string, number> = {}; for (const p of keep) secCount[sectorOf(p.sym)] = (secCount[sectorOf(p.sym)] ?? 0) + 1
    for (const L of LEGS) {
      const mine = keep.filter(p => p.leg === L.leg).length
      let free = Math.min(L.slots - mine, Math.floor(room / slotSize + 1e-9))
      if (free <= 0) continue
      const c: [string, number][] = []
      for (const u of universe) { if (held.has(u) || exiting.has(u)) continue; const s = S[u]; const i = s.idx.get(dates[t]); if (i === undefined) continue; const sc = entryScore(L.leg, s, i); if (sc !== null && ok(sc)) c.push([u, sc]) }
      for (const [u] of c.sort((a, b) => b[1] - a[1])) {
        if (free <= 0) break
        const sec = sectorOf(u); if (cfg.p4 && (secCount[sec] ?? 0) >= 3) continue
        pendE.push([u, L.leg]); held.add(u); secCount[sec] = (secCount[sec] ?? 0) + 1; free--; room -= slotSize
      }
    }
  }
  return { eq, rets, trades: nTrades, win: nTrades ? 100 * wins / nTrades : 0 }
}
function stats(eq: Float64Array, a: number, b: number) {
  let pk = eq[a], mdd = 0; const r: number[] = []
  for (let t = a + 1; t <= b; t++) { if (!ok(eq[t])) continue; r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); mdd = Math.max(mdd, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  const cagr = Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1
  return { cagr: 100 * cagr, mdd: 100 * mdd, sharpe: sd > 0 ? mu / sd * Math.sqrt(252) : 0 }
}
const periodRet = (eq: Float64Array, a: number, b: number) => 100 * (eq[b] / eq[a] - 1)
/* Share of calendar months and years that ended below where they started. */
function negShare(eq: Float64Array, a: number, b: number) {
  const ends = (key: (t: number) => string) => { const m = new Map<string, number>(); for (let t = a; t <= b; t++) if (ok(eq[t])) m.set(key(t), t); return [...m.values()] }
  const calc = (idx: number[]) => { let neg = 0, n = 0; let prev = a; for (const t of idx) { if (t === prev) continue; n++; if (eq[t] < eq[prev]) neg++; prev = t } return n ? 100 * neg / n : 0 }
  return { months: calc(ends(t => iso(t).slice(0, 7))), years: calc(ends(t => iso(t).slice(0, 4))), worstMonth: (() => { let w = 0, prev = a; for (const t of ends(x => iso(x).slice(0, 7))) { if (t === prev) continue; w = Math.min(w, eq[t] / eq[prev] - 1); prev = t } return 100 * w })() }
}
function periodDD(eq: Float64Array, a: number, b: number) { let pk = eq[a], m = 0; for (let t = a; t <= b; t++) { pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) } return 100 * m }

/* Block bootstrap: stitch random 20-day blocks of the book's own daily
   returns into 2,000 alternate 9-year histories. Keeps streaks intact. */
function monteCarlo(rets: number[], runs = 2000, block = 20) {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const n = rets.length, cagrs: number[] = [], mdds: number[] = []
  for (let k = 0; k < runs; k++) {
    let v = 1, pk = 1, m = 0, len = 0
    while (len < n) { const s = Math.floor(rnd() * (n - block)); for (let j = 0; j < block && len < n; j++, len++) { v *= 1 + rets[s + j]; pk = Math.max(pk, v); m = Math.max(m, 1 - v / pk) } }
    cagrs.push(100 * (Math.pow(v, 252 / n) - 1)); mdds.push(100 * m)
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]
  return { cagr5: q(cagrs, 0.05), cagr50: q(cagrs, 0.5), cagr95: q(cagrs, 0.95), mdd50: q(mdds, 0.5), mdd90: q(mdds, 0.9), lossYears: 100 * cagrs.filter(x => x < 0).length / runs }
}

/* ── 1. the grid, ranked on 2017-2023 only ── */
const LS = [1, 1.25, 1.5, 1.75, 2, 2.5]
const grid: Cfg[] = []
for (const L of LS) for (let m = 0; m < 64; m++) grid.push({ L, p1: !!(m & 1), p2: !!(m & 2), p3: !!(m & 4), p4: !!(m & 8), p5: !!(m & 16), q: !!(m & 32) })
console.log(`\nFRONTIER: ${grid.length} setups (combo rules, optional quick-profit dips, leverage, 5 protections), ${FULL.length} stocks, ${iso(START)} to ${iso(N - 1)}. Picked on ${iso(START)}..${iso(SPLIT)} (IS), judged on ${iso(SPLIT)}..${iso(N - 1)} (OOS).\n`)
const rows = grid.map(c => { const r = simulate(c, FULL); return { c, r, all: stats(r.eq, START, N - 1), is: stats(r.eq, START, SPLIT), oos: stats(r.eq, SPLIT, N - 1), neg: negShare(r.eq, START, N - 1), negIS: negShare(r.eq, START, SPLIT) } })
const base = rows.find(x => x.c.L === 1 && !x.c.p1 && !x.c.p2 && !x.c.p3 && !x.c.p4 && !x.c.p5 && !x.c.q)!

/* ── 2. the frontier: best IS growth for each drawdown budget ── */
const BUDGETS = [12, 15, 18, 22, 25, 30]
const picks: typeof rows = []
console.log(`Best setup per worst-drop budget (chosen on IS, then shown on the full period and OOS)`)
console.log(`${'budget'.padEnd(8)}${'setup'.padEnd(42)}${'IS CAGR'.padStart(9)}${'IS DD'.padStart(8)}${'full CAGR'.padStart(11)}${'full DD'.padStart(9)}${'Sharpe'.padStart(8)}${'OOS CAGR'.padStart(10)}${'OOS DD'.padStart(8)}${'win%'.padStart(7)}${'neg months'.padStart(12)}${'neg years'.padStart(11)}`)
for (const B of BUDGETS) {
  const p = rows.filter(x => x.is.mdd <= B).sort((a, b) => b.is.cagr - a.is.cagr)[0]
  if (!p) { console.log(`${('-' + B + '%').padEnd(8)}nothing fits`); continue }
  if (!picks.includes(p)) picks.push(p)
  console.log(`${('-' + B + '%').padEnd(8)}${label(p.c).padEnd(42)}${(p.is.cagr.toFixed(1) + '%').padStart(9)}${(p.is.mdd.toFixed(1) + '%').padStart(8)}${(p.all.cagr.toFixed(1) + '%').padStart(11)}${(p.all.mdd.toFixed(1) + '%').padStart(9)}${p.all.sharpe.toFixed(2).padStart(8)}${(p.oos.cagr.toFixed(1) + '%').padStart(10)}${(p.oos.mdd.toFixed(1) + '%').padStart(8)}${p.r.win.toFixed(1).padStart(7)}${(p.neg.months.toFixed(0) + '%').padStart(12)}${(p.neg.years.toFixed(0) + '%').padStart(11)}`)
}
const calm = rows.filter(x => x.is.cagr >= base.is.cagr).sort((a, b) => a.negIS.months - b.negIS.months || b.is.cagr - a.is.cagr)[0]
if (calm && !picks.includes(calm)) picks.push(calm)
const winPick = rows.filter(x => x.is.cagr >= base.is.cagr && x.is.mdd <= base.is.mdd).sort((a, b) => b.r.win - a.r.win)[0]
if (winPick && !picks.includes(winPick)) picks.push(winPick)
console.log(`\nFewest losing months while growing at least as fast as today (IS): ${calm ? `${label(calm.c)}: ${calm.neg.months.toFixed(0)}% of months negative, ${calm.neg.years.toFixed(0)}% of years, worst month ${calm.neg.worstMonth.toFixed(1)}%, ${calm.all.cagr.toFixed(1)}%/yr, DD ${calm.all.mdd.toFixed(0)}%, win ${calm.r.win.toFixed(1)}%` : 'none'}`)
console.log(`Highest win rate with growth and drop at least as good as today (IS): ${winPick ? `${label(winPick.c)}: win ${winPick.r.win.toFixed(1)}%, ${winPick.all.cagr.toFixed(1)}%/yr, DD ${winPick.all.mdd.toFixed(0)}%, ${winPick.neg.months.toFixed(0)}% negative months` : 'none'}`)
console.log(`Today's live combo for reference: win ${base.r.win.toFixed(1)}%, ${base.all.cagr.toFixed(1)}%/yr, DD ${base.all.mdd.toFixed(0)}%, ${base.neg.months.toFixed(0)}% negative months, ${base.neg.years.toFixed(0)}% negative years, worst month ${base.neg.worstMonth.toFixed(1)}%`)
const target = rows.filter(x => x.is.cagr >= 40 && x.is.mdd <= 18)
console.log(`\nTarget 40%+ a year with an 18% or smaller drop (IS): ${target.length ? target.map(x => label(x.c)).join(', ') : 'no setup reaches it'}`)

/* ── 3. stress tests on the picks + the baseline ── */
const winners = [...FULL].map(u => { const c = S[u].c; let a = -1, b = -1; for (let t = 0; t < c.length; t++) if (ok(c[t])) { if (a < 0) a = t; b = t } return [u, a >= 0 && b > a ? Math.pow(c[b] / c[a], 252 / (b - a)) : 0] as [string, number] }).sort((x, y) => y[1] - x[1]).slice(0, 10).map(x => x[0])
const exWin = FULL.filter(u => !winners.includes(u))
const c20a = dayIdx('2020-02-19'), c20b = dayIdx('2020-03-23'), y22a = dayIdx('2022-01-03'), y22b = dayIdx('2022-12-30')
console.log(`\nStress tests (baseline = today's live combo, 1x, no protections)`)
console.log(`${'setup'.padEnd(42)}${'win%'.padStart(6)}${'negMo'.padStart(7)}${'CAGR'.padStart(7)}${'DD'.padStart(7)}${'exWin CAGR'.padStart(12)}${'exWin DD'.padStart(10)}${'2xCost'.padStart(8)}${'2020 crash'.padStart(12)}${'2022'.padStart(8)}${'2022 DD'.padStart(9)}${'MC CAGR 5-50-95%'.padStart(20)}${'MC DD med/90%'.padStart(16)}${'MC losing'.padStart(11)}`)
for (const p of [base, ...picks]) {
  const xw = simulate(p.c, exWin), c2 = simulate(p.c, FULL, 2)
  const a = stats(p.r.eq, START, N - 1), b = stats(xw.eq, START, N - 1), d = stats(c2.eq, START, N - 1)
  const mc = monteCarlo(p.r.rets)
  console.log(`${label(p.c).padEnd(42)}${p.r.win.toFixed(1).padStart(6)}${(p.neg.months.toFixed(0) + '%').padStart(7)}${(a.cagr.toFixed(1) + '%').padStart(7)}${(a.mdd.toFixed(0) + '%').padStart(7)}${(b.cagr.toFixed(1) + '%').padStart(12)}${(b.mdd.toFixed(0) + '%').padStart(10)}${(d.cagr.toFixed(1) + '%').padStart(8)}${(periodRet(p.r.eq, c20a, c20b).toFixed(1) + '%').padStart(12)}${(periodRet(p.r.eq, y22a, y22b).toFixed(1) + '%').padStart(8)}${(periodDD(p.r.eq, y22a, y22b).toFixed(0) + '%').padStart(9)}${`${mc.cagr5.toFixed(0)} / ${mc.cagr50.toFixed(0)} / ${mc.cagr95.toFixed(0)}%`.padStart(20)}${`${mc.mdd50.toFixed(0)} / ${mc.mdd90.toFixed(0)}%`.padStart(16)}${(mc.lossYears.toFixed(1) + '%').padStart(11)}`)
}
console.log(`\nSPY over the same windows: 2020 crash ${periodRet(new Float64Array(spy.c), c20a, c20b).toFixed(1)}%, 2022 ${periodRet(new Float64Array(spy.c), y22a, y22b).toFixed(1)}%.`)

/* ── 4. neighbor check on the -18% and -22% picks ── */
console.log(`\nNeighbor check (same protections, leverage one step either side). Smooth = real, jagged = luck.`)
for (const p of picks) {
  const same = rows.filter(x => x.c.p1 === p.c.p1 && x.c.p2 === p.c.p2 && x.c.p3 === p.c.p3 && x.c.p4 === p.c.p4 && x.c.p5 === p.c.p5 && x.c.q === p.c.q).sort((a, b) => a.c.L - b.c.L)
  console.log(`  ${label(p.c).padEnd(40)} ${same.map(x => `${x.c.L}x: ${x.all.cagr.toFixed(0)}%/${x.all.mdd.toFixed(0)}%`).join('  ')}`)
}
console.log(`\nMC = 2,000 reshuffled histories built from the setup's own daily returns in 20-day blocks. "MC losing" = share of histories that lost money over the full period.\n`)
