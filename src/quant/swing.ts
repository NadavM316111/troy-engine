/* ═══════════════════════════════════════════════════════════════════════════
   SWING RESEARCH - which multi-day strategies would have made money on
   Troy's universe over ~10 years, out of sample, after costs?

     npm run q:swing

   Every strategy is simulated as a real portfolio: fixed number of equal
   slots, signals read at the close, orders filled at the NEXT open (no
   lookahead), 5bp per side, cash earns nothing. Each one is scored as a
   whole book (CAGR, Sharpe, drawdown) and trade by trade (win rate,
   average win and loss, expectancy).

   IS = first 70% of the history, OOS = last 30%. Nothing here was tuned on
   OOS. The parameters are the textbook ones, not optimized, on purpose.

   Survivorship bias, the big caveat: the universe is today's winners. NVDA
   and PLTR are in the list because they went up. That inflates every
   long strategy, buy-and-hold most of all. So the fair test is not "did it
   make money" but "did it beat equal-weight buy-and-hold of the SAME
   stocks", and did it do so with less risk.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'

const BASE_COST = 0.0005  // per side

/* ── align everything to SPY's calendar ── */
const raw = loadDaily()
if (!raw['SPY']) throw new Error('SPY missing. Run npm run q:daily')
const dates = raw['SPY'].map(b => b[0])
const N = dates.length
const di = new Map(dates.map((d, i) => [d, i]))

interface Series { o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; sma5: Float64Array; sma10: Float64Array; sma50: Float64Array; sma200: Float64Array; rsi2: Float64Array; ret5: Float64Array; ret20: Float64Array; ret126: Float64Array; hh20: Float64Array; ll10: Float64Array; ibs: Float64Array }
const nan = () => new Float64Array(N).fill(NaN)
function build(bars: [number, number, number, number, number, number][]): Series {
  const s: Series = { o: nan(), h: nan(), l: nan(), c: nan(), sma5: nan(), sma10: nan(), sma50: nan(), sma200: nan(), rsi2: nan(), ret5: nan(), ret20: nan(), ret126: nan(), hh20: nan(), ll10: nan(), ibs: nan() }
  for (const b of bars) { const i = di.get(b[0]); if (i === undefined) continue; s.o[i] = b[1]; s.h[i] = b[2]; s.l[i] = b[3]; s.c[i] = b[4] }
  const sma = (out: Float64Array, n: number) => { for (let i = n - 1; i < N; i++) { let x = 0; for (let k = i - n + 1; k <= i; k++) x += s.c[k]; out[i] = x / n } }
  sma(s.sma5, 5); sma(s.sma10, 10); sma(s.sma50, 50); sma(s.sma200, 200)
  // Wilder RSI(2)
  let ag = NaN, al = NaN
  for (let i = 1; i < N; i++) {
    const d = s.c[i] - s.c[i - 1]; if (!Number.isFinite(d)) { ag = al = NaN; continue }
    const g = Math.max(0, d), l = Math.max(0, -d)
    if (!Number.isFinite(ag)) { ag = g; al = l } else { ag = (ag * 1 + g) / 2; al = (al * 1 + l) / 2 }
    s.rsi2[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  }
  for (let i = 0; i < N; i++) {
    if (i >= 5) s.ret5[i] = s.c[i] / s.c[i - 5] - 1
    if (i >= 20) s.ret20[i] = s.c[i] / s.c[i - 20] - 1
    if (i >= 131) s.ret126[i] = s.c[i - 5] / s.c[i - 131] - 1   // 6-month momentum, skipping the last week
    if (i >= 20) { let m = -Infinity; for (let k = i - 20; k < i; k++) m = Math.max(m, s.h[k]); s.hh20[i] = m }
    if (i >= 10) { let m = Infinity; for (let k = i - 10; k < i; k++) m = Math.min(m, s.l[k]); s.ll10[i] = m }
    const rg = s.h[i] - s.l[i]; s.ibs[i] = rg > 0 ? (s.c[i] - s.l[i]) / rg : 0.5
  }
  return s
}
const S: Record<string, Series> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = build(bars as any)
const FULL_UNIVERSE = STOCK_LIBRARY.map(x => x.sym).filter(x => S[x])
let UNIVERSE = FULL_UNIVERSE
let PASS = 'full'
let COSTX = 1
const ok = (x: number) => Number.isFinite(x)

/* ── cross-sectional ranks, cached per day ── */
const rankCache = new Map<string, Map<string, number>>()
function rankOf(field: 'ret126' | 'ret5', t: number, filter: (s: Series) => boolean): Map<string, number> {
  const k = `${PASS}|${field}|${t}`
  let m = rankCache.get(k)
  if (!m) {
    const xs = UNIVERSE.filter(u => ok(S[u][field][t]) && filter(S[u])).sort((a, b) => S[b][field][t] - S[a][field][t])
    m = new Map(xs.map((u, i) => [u, i])); rankCache.set(k, m)
  }
  return m
}

/* ── strategies ── */
interface Pos { sym: string; entryT: number; entryPx: number; shares: number; part: number }
interface Strat {
  name: string; desc: string; slots: number; maxHold: number; universe?: string[]; every?: number
  entry(sym: string, t: number): number | null   // score, higher first; null = no entry
  exit(p: Pos, t: number): boolean
  parts?: Strat[]   // combo: components share one book, earlier parts get cash first
}
const up = (s: Series, t: number) => s.c[t] > s.sma200[t]
const STRATS: Strat[] = [
  { name: 'RSI2 pullback <10', desc: 'Uptrend (above 200-day avg), 2-day RSI under 10. Exit when close > 5-day avg.', slots: 10, maxHold: 10, 
    entry: (u, t) => { const s = S[u]; return up(s, t) && s.rsi2[t] < 10 ? -s.rsi2[t] : null },
    exit: (p, t) => S[p.sym].c[t] > S[p.sym].sma5[t] },
  { name: 'RSI2 pullback <5', desc: 'Same, stricter dip.', slots: 10, maxHold: 10, 
    entry: (u, t) => { const s = S[u]; return up(s, t) && s.rsi2[t] < 5 ? -s.rsi2[t] : null },
    exit: (p, t) => S[p.sym].c[t] > S[p.sym].sma5[t] },
  { name: '3 down days in uptrend', desc: 'Uptrend, three lower closes in a row. Exit when close > 5-day avg.', slots: 10, maxHold: 10, 
    entry: (u, t) => { const s = S[u]; return up(s, t) && s.c[t] < s.c[t - 1] && s.c[t - 1] < s.c[t - 2] && s.c[t - 2] < s.c[t - 3] ? -(s.c[t] / s.c[t - 3] - 1) : null },
    exit: (p, t) => S[p.sym].c[t] > S[p.sym].sma5[t] },
  { name: 'Low close in uptrend (IBS)', desc: 'Uptrend, closed in the bottom 15% of the day range. Exit on a close above prior high.', slots: 10, maxHold: 5, 
    entry: (u, t) => { const s = S[u]; return up(s, t) && s.ibs[t] < 0.15 ? -s.ibs[t] : null },
    exit: (p, t) => S[p.sym].c[t] > S[p.sym].h[t - 1] },
  { name: '20-day breakout', desc: 'Uptrend, close above the prior 20-day high. Exit below the prior 10-day low.', slots: 10, maxHold: 60, 
    entry: (u, t) => { const s = S[u]; return up(s, t) && s.c[t] > s.hh20[t] ? s.ret20[t] : null },
    exit: (p, t) => S[p.sym].c[t] < S[p.sym].ll10[t] },
  { name: 'Momentum rotation (weekly)', desc: 'Every 5 days hold the top 10 by 6-month return (in uptrend). Drop names that fall out of the top 20.', slots: 10, maxHold: 9999,  every: 5,
    entry: (u, t) => { const r = rankOf('ret126', t, s => up(s, t)).get(u); return r !== undefined && r < 10 ? -r : null },
    exit: (p, t) => { const r = rankOf('ret126', t, s => up(s, t)).get(p.sym); return r === undefined || r >= 20 } },
  { name: 'Weekly reversal', desc: 'Every 5 days buy the 10 worst 5-day losers that are still in an uptrend. Hold 5 days.', slots: 10, maxHold: 5,  every: 5,
    entry: (u, t) => { const r = rankOf('ret5', t, s => up(s, t)); const n = r.size; const k = r.get(u); return k !== undefined && k >= n - 10 ? k : null },
    exit: () => false },
  { name: 'SPY trend (200-day)', desc: 'Hold SPY above its 200-day average, cash below. The classic risk filter.', slots: 1, maxHold: 99999, universe: ['SPY'],
    entry: (u, t) => up(S[u], t) ? 1 : null,
    exit: (p, t) => !up(S[p.sym], t) },
]
const byName = (n: string) => STRATS.find(x => x.name === n)!
const spyUp = (t: number) => up(S['SPY'], t)
const withMarketFilter = (b: Strat, name: string): Strat => ({ ...b, name, desc: `${b.name}, but only enter while SPY is above its 200-day average.`, entry: (u, t) => spyUp(t) ? b.entry(u, t) : null })
STRATS.push(
  withMarketFilter(byName('20-day breakout'), 'Breakout + SPY filter'),
  withMarketFilter(byName('Momentum rotation (weekly)'), 'Momentum + SPY filter'),
  { name: 'Combo: breakout + RSI2 dips', desc: 'Breakout gets cash first (10 slots). Idle cash buys RSI2 <5 dips (up to 5 slots). One shared book.', slots: 10, maxHold: 0,
    entry: () => null, exit: () => false, parts: [byName('20-day breakout'), { ...byName('RSI2 pullback <5'), slots: 5 }] },
  { name: 'Combo: filtered breakout + dips', desc: 'Same combo, breakout leg only while SPY is above its 200-day average.', slots: 10, maxHold: 0,
    entry: () => null, exit: () => false, parts: [withMarketFilter(byName('20-day breakout'), 'x'), { ...byName('RSI2 pullback <5'), slots: 5 }] },
)

/* ── portfolio simulator ── */
const START = 210
const SPLIT = START + Math.floor((N - START) * 0.7)
interface Tr { sym: string; entryT: number; exitT: number; ret: number; net: number; hold: number }
function simulate(st: Strat) {
  const COST = BASE_COST * COSTX
  const parts = st.parts ?? [st]
  let cash = 1, equity = 1
  const pos: Pos[] = [], trades: Tr[] = []
  const eq = new Float64Array(N).fill(NaN), expo = new Float64Array(N).fill(0)
  let pendExit: Pos[] = [], pendEntry: [string, number][] = []
  const last = (sym: string, t: number) => { const c = S[sym].c; for (let k = t; k >= 0; k--) if (ok(c[k])) return c[k]; return NaN }
  for (let t = START; t < N; t++) {
    for (const p of pendExit) {
      const px = S[p.sym].o[t]; const fill = ok(px) ? px : last(p.sym, t - 1)
      cash += p.shares * fill * (1 - COST)
      pos.splice(pos.indexOf(p), 1)
      trades.push({ sym: p.sym, entryT: p.entryT, exitT: t, ret: fill / p.entryPx - 1, net: (fill * (1 - COST)) / (p.entryPx * (1 + COST)) - 1, hold: t - p.entryT })
    }
    const slotSize = equity / st.slots
    for (const [u, pi] of pendEntry) {
      if (pos.filter(p => p.part === pi).length >= parts[pi].slots) continue
      const px = S[u].o[t]; if (!ok(px)) continue
      const alloc = Math.min(cash, slotSize); if (alloc < slotSize * 0.5) break
      pos.push({ sym: u, entryT: t, entryPx: px, shares: alloc / (px * (1 + COST)), part: pi }); cash -= alloc
    }
    pendExit = []; pendEntry = []
    let inv = 0; for (const p of pos) inv += p.shares * last(p.sym, t)
    equity = cash + inv; eq[t] = equity; expo[t] = equity > 0 ? inv / equity : 0
    if (t === N - 1) break
    for (const p of pos) {
      const part = parts[p.part], s = S[p.sym]; if (!ok(s.c[t])) continue
      const rebal = !part.every || (t - START) % part.every === 0
      if (t - p.entryT + 1 >= part.maxHold || (rebal && part.exit(p, t))) pendExit.push(p)
    }
    // cash available tomorrow, in slots, shared across parts in priority order
    let freeCash = cash + pendExit.reduce((a, p) => a + p.shares * last(p.sym, t), 0)
    const held = new Set(pos.filter(p => !pendExit.includes(p)).map(p => p.sym))
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      const rebal = !part.every || (t - START) % part.every === 0
      if (!rebal) continue
      const mine = pos.filter(p => p.part === pi && !pendExit.includes(p)).length
      let free = Math.min(part.slots - mine, Math.floor(freeCash / slotSize + 1e-9))
      if (free <= 0) continue
      const cands: [string, number][] = []
      for (const u of part.universe ?? UNIVERSE) {
        if (held.has(u) || pendExit.some(p => p.sym === u)) continue
        const s = S[u]; if (!s || !ok(s.c[t]) || !ok(s.sma200[t]) || !ok(s.rsi2[t])) continue
        const sc = part.entry(u, t); if (sc !== null && ok(sc)) cands.push([u, sc])
      }
      for (const [u] of cands.sort((a, b) => b[1] - a[1]).slice(0, free)) { pendEntry.push([u, pi]); held.add(u); freeCash -= slotSize }
    }
  }
  for (const p of pos) { const px = last(p.sym, N - 1); trades.push({ sym: p.sym, entryT: p.entryT, exitT: N - 1, ret: px / p.entryPx - 1, net: (px * (1 - BASE_COST * COSTX)) / (p.entryPx * (1 + BASE_COST * COSTX)) - 1, hold: N - 1 - p.entryT }) }
  return { eq, expo, trades }
}

/* ── metrics ── */
function curve(eq: Float64Array, a: number, b: number) {
  const r: number[] = []; let peak = eq[a], mdd = 0
  for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); peak = Math.max(peak, eq[t]); mdd = Math.max(mdd, 1 - eq[t] / peak) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, mdd }
}
function tstats(ts: Tr[]) {
  const w = ts.filter(x => x.ret > 0), l = ts.filter(x => x.ret <= 0)
  const gw = ts.filter(x => x.net > 0).reduce((s, x) => s + x.net, 0), gl = -ts.filter(x => x.net <= 0).reduce((s, x) => s + x.net, 0)
  const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0
  return { n: ts.length, win: ts.length ? 100 * w.length / ts.length : 0, avgWin: 100 * mean(w.map(x => x.ret)), avgLoss: 100 * mean(l.map(x => x.ret)), expBp: 1e4 * mean(ts.map(x => x.net)), pf: gl > 0 ? gw / gl : 0, hold: mean(ts.map(x => x.hold)) }
}

/* benchmarks */
function benchSPY() { const eq = new Float64Array(N).fill(NaN); for (let t = START; t < N; t++) eq[t] = S['SPY'].c[t] / S['SPY'].c[START]; return eq }
function benchEW() {
  const eq = new Float64Array(N).fill(NaN); eq[START] = 1
  for (let t = START + 1; t < N; t++) {
    const rs = UNIVERSE.map(u => S[u].c[t] / S[u].c[t - 1] - 1).filter(ok)
    eq[t] = eq[t - 1] * (1 + (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0))
  }
  return eq
}

/* ── run ── */
const yrs = (N - START) / 252
const toDate = (t: number) => new Date(dates[t] * 86400000).toISOString().slice(0, 10)
const pct = (x: number, d = 1) => (100 * x).toFixed(d) + '%'
const H = `${'strategy'.padEnd(32)}${'trades'.padStart(7)}${'/yr'.padStart(5)}${'win%'.padStart(7)}${'avgW%'.padStart(7)}${'avgL%'.padStart(7)}${'exp bp'.padStart(8)}${'PF'.padStart(6)}${'hold'.padStart(6)}${'CAGR'.padStart(8)}${'Sharpe'.padStart(7)}${'maxDD'.padStart(7)}${'expo'.padStart(6)}${'IS CAGR'.padStart(9)}${'OOS CAGR'.padStart(9)}${'OOS Shp'.padStart(8)}${'OOS win'.padStart(8)}`

/* Hindsight winners: best annualized return over each stock's own history.
   Removing them is the survivorship stress test. */
function biggestWinners(n: number): string[] {
  return [...FULL_UNIVERSE].map(u => {
    const c = S[u].c; let a = -1, b = -1
    for (let t = START; t < N; t++) if (ok(c[t])) { if (a < 0) a = t; b = t }
    return [u, a >= 0 && b > a ? Math.pow(c[b] / c[a], 252 / (b - a)) - 1 : -1] as [string, number]
  }).sort((x, y) => y[1] - x[1]).slice(0, n).map(x => x[0])
}

function runPass(title: string) {
  console.log(`\n=== ${title} ===`)
  console.log(H); console.log('-'.repeat(H.length))
  const rows: any[] = []
  for (const [name, eq] of [['SPY buy & hold', benchSPY()], ['Equal-weight buy & hold', benchEW()]] as [string, Float64Array][]) {
    const a = curve(eq, START, N - 1), i = curve(eq, START, SPLIT), o = curve(eq, SPLIT, N - 1)
    console.log(`${name.padEnd(32)}${'-'.padStart(7)}${'-'.padStart(5)}${'-'.padStart(7)}${'-'.padStart(7)}${'-'.padStart(7)}${'-'.padStart(8)}${'-'.padStart(6)}${'-'.padStart(6)}${pct(a.cagr).padStart(8)}${a.sharpe.toFixed(2).padStart(7)}${pct(a.mdd, 0).padStart(7)}${'100%'.padStart(6)}${pct(i.cagr).padStart(9)}${pct(o.cagr).padStart(9)}${o.sharpe.toFixed(2).padStart(8)}${'-'.padStart(8)}`)
    rows.push({ name, ...a, is: i, oos: o, bench: true })
  }
  for (const st of STRATS) {
    const { eq, expo, trades } = simulate(st)
    const a = curve(eq, START, N - 1), i = curve(eq, START, SPLIT), o = curve(eq, SPLIT, N - 1)
    const ts = tstats(trades), tsO = tstats(trades.filter(x => x.entryT >= SPLIT))
    let ex = 0; for (let t = START; t < N; t++) ex += expo[t]; ex /= (N - START)
    console.log(`${st.name.padEnd(32)}${String(ts.n).padStart(7)}${(ts.n / yrs).toFixed(0).padStart(5)}${ts.win.toFixed(1).padStart(7)}${ts.avgWin.toFixed(2).padStart(7)}${ts.avgLoss.toFixed(2).padStart(7)}${ts.expBp.toFixed(1).padStart(8)}${ts.pf.toFixed(2).padStart(6)}${ts.hold.toFixed(1).padStart(6)}${pct(a.cagr).padStart(8)}${a.sharpe.toFixed(2).padStart(7)}${pct(a.mdd, 0).padStart(7)}${pct(ex, 0).padStart(6)}${pct(i.cagr).padStart(9)}${pct(o.cagr).padStart(9)}${o.sharpe.toFixed(2).padStart(8)}${tsO.win.toFixed(1).padStart(8)}`)
    rows.push({ name: st.name, desc: st.desc, ...a, is: i, oos: o, trades: ts, oosTrades: tsO, exposure: ex })
  }
  return rows
}

console.log(`\nSWING RESEARCH: ${FULL_UNIVERSE.length} stocks, ${toDate(START)} to ${toDate(N - 1)} (${yrs.toFixed(1)} years). IS until ${toDate(SPLIT)}, OOS after. Fills at next open.`)
const passes: Record<string, any[]> = {}
PASS = 'full'; UNIVERSE = FULL_UNIVERSE; COSTX = 1
passes.full = runPass('1. Full universe, 5bp per side')
const winners = biggestWinners(10)
PASS = 'exwin'; UNIVERSE = FULL_UNIVERSE.filter(u => !winners.includes(u)); COSTX = 1
passes.exWinners = runPass(`2. Survivorship stress test: WITHOUT the 10 biggest winners (${winners.join(', ')})`)
PASS = 'cost2'; UNIVERSE = FULL_UNIVERSE; COSTX = 2
passes.doubleCost = runPass('3. Cost stress test: full universe, 10bp per side')
COSTX = 1

console.log(`\nwin% = trades closed above entry. exp bp = average trade after costs (100bp = 1%). PF = gross wins / gross losses after costs.`)
console.log(`hold = average days held. expo = average share of capital invested. CAGR = yearly growth of the whole book.\n`)
console.log('Strategies:'); for (const st of STRATS) console.log(`  ${st.name.padEnd(32)} ${st.desc}`)

console.log(`\n── Verdict: what beats equal-weight buy & hold in ALL THREE tests ──`)
const names = STRATS.map(s => s.name)
for (const n of names) {
  const res = (['full', 'exWinners', 'doubleCost'] as const).map(k => {
    const ew = passes[k].find(r => r.name === 'Equal-weight buy & hold'), r = passes[k].find(x => x.name === n)
    return { sharpe: r.sharpe > ew.sharpe, dd: r.mdd < ew.mdd, oos: r.oos.cagr > 0, r, ew }
  })
  const all = res.every(x => x.sharpe && x.oos)
  const f = res[0].r, x = res[1].r
  console.log(`  ${all ? 'PASS' : 'fail'}  ${n.padEnd(32)} Sharpe ${f.sharpe.toFixed(2)} / ex-winners ${x.sharpe.toFixed(2)} / 2x cost ${res[2].r.sharpe.toFixed(2)}   win ${f.trades.win.toFixed(1)}%   CAGR ${pct(f.cagr)} / ex-winners ${pct(x.cagr)}   maxDD ${pct(f.mdd, 0)}`)
}
const ewF = passes.full.find(r => r.name === 'Equal-weight buy & hold'), ewX = passes.exWinners.find(r => r.name === 'Equal-weight buy & hold')
console.log(`  bar: equal-weight buy & hold Sharpe ${ewF.sharpe.toFixed(2)} / ex-winners ${ewX.sharpe.toFixed(2)}, CAGR ${pct(ewF.cagr)} / ex-winners ${pct(ewX.cagr)}, maxDD ${pct(ewF.mdd, 0)}`)

mkdirSync(join(process.cwd(), 'quant', 'out'), { recursive: true })
const file = join(process.cwd(), 'quant', 'out', `swing-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(passes, null, 1))
console.log(`\nSaved ${file}`)
