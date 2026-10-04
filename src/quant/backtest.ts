/* ═══════════════════════════════════════════════════════════════════════════
   BACKTEST - replays the REAL engine.ts + rules.ts over historical minutes.

   Not a reimplementation. The exact code running on Railway is imported and
   fed historical quotes one minute at a time, with the clock mocked so every
   cooldown, timeout and grace period sees historical time. Whatever this
   proves is true of what is deployed, within the limits below.

   Usage
     npm run q:backtest                                  baseline only
     npm run q:backtest -- --set SS55_BENCH_PCT=-0.003   baseline vs one change
     npm run q:backtest -- --set A=1 --set B=2           baseline vs a combined change
     npm run q:backtest -- --sweep SS59_FLOOR_PCT=0.003,0.006,0.01
     npm run q:backtest -- --trades                      also print every trade

   Settings come from quant/backtest.config.json if present (budget, modes).

   Honest limits
     * 1-minute steps. Live ticks every 10s, so every "N bars" rule sees a
       longer window here than live. Results are directional, not exact.
       The fix is to make live bars 1-minute too; then research == production.
     * Fills at the last minute close. Costs are charged separately at
       COST_PER_SIDE per side, which is the honest number to read.
     * ~30 days of history. Enough to kill bad ideas, not enough to crown a
       good one. Always read the first-half vs second-half columns.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadAll, byDay, tradingDays, etToUtc, type Bar } from './data.js'
import { score, type Score } from '../score.js'
import { STOCK_LIBRARY, SAFE_STOCKS } from '../rules.js'
import { emptyRefs, type PortfolioState, type Quote, type VAP, type Trade, type EngineRefs } from '../types.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(process.cwd(), 'quant', 'out')

/* ── args ── */
const argv = process.argv.slice(2)
const sets: [string, string][] = []
const sweeps: [string, string[]][] = []
let printTrades = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--set')   { const [k, ...v] = argv[++i].split('='); sets.push([k, v.join('=')]) }
  if (a === '--sweep') { const [k, ...v] = argv[++i].split('='); sweeps.push([k, v.join('=').split(',')]) }
  if (a === '--trades') printTrades = true
}

/* ── settings ── */
interface Cfg { budget: number; targetReturn: number; stocks: string[]; aiPicksStocks: boolean; safeAlloc: number; riskAlloc: number; allIn: boolean; zangerMode: boolean; beastMode: boolean; regimeRouter: boolean }
const DEFAULT_CFG: Cfg = { budget: 1_000_000, targetReturn: 20, stocks: [], aiPicksStocks: true, safeAlloc: 0, riskAlloc: 100, allIn: true, zangerMode: false, beastMode: false, regimeRouter: true }
const cfgPath = join(process.cwd(), 'quant', 'backtest.config.json')
const cfg: Cfg = { ...DEFAULT_CFG, ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}) }

function freshState(t: number): PortfolioState {
  return {
    budget: cfg.budget, targetReturn: cfg.targetReturn, stocks: cfg.stocks, aiPicksStocks: cfg.aiPicksStocks,
    cash: cfg.budget, positions: [], trades: [], totalValue: cfg.budget, totalPnl: 0, totalPnlPct: 0, dayPnl: 0, dayPnlPct: 0,
    lastUpdated: t, troyThesis: '', marketCondition: 'SCANNING', nextAction: '', riskLevel: 'MODERATE', scanCount: 0, startDate: t,
    valueHistory: [{ t, v: cfg.budget }], isPaper: true, winCount: 0, lossCount: 0, realizedPnl: 0,
    safeAlloc: cfg.safeAlloc, riskAlloc: cfg.riskAlloc, allIn: cfg.allIn, withdrawn: false, withdrawnValue: 0,
    zangerMode: cfg.zangerMode, beastMode: cfg.beastMode, regimeRouter: cfg.regimeRouter,
    regime: 'PENDING', activeMode: 'PENDING', roster: [], bench: [], switchBudget: 0, lastRegimeEvalMin: 0,
    beastLockedOut: false, universeDefect: false, lessonsLedger: [], lastReviewDay: 0, dailyLog: [], currentDay: 0, dayOpenValue: cfg.budget,
  }
}

/* ── engine loading: the real one, or a patched copy for a variant ── */
type RunEngine = (i: any) => any
async function loadEngine(over: [string, string][]): Promise<RunEngine> {
  if (!over.length) return (await import('../engine.js')).runEngine
  const dir = join(tmpdir(), `troy-variant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  for (const f of ['engine.ts', 'rules.ts', 'indicators.ts', 'types.ts', 'quotes.ts']) copyFileSync(join(SRC, f), join(dir, f))
  const lines = readFileSync(join(dir, 'rules.ts'), 'utf8').split('\n')
  for (const [k, v] of over) {
    const re = new RegExp(`(\\b${k}\\s*(?::[^=]+)?=\\s*)([^,\\n]*?)(\\s*(?:,|//|$))`)
    const idx = lines.findIndex(l => l.startsWith('export const') && re.test(l))
    if (idx < 0) throw new Error(`--set ${k}: no "export const ${k}" in rules.ts`)
    lines[idx] = lines[idx].replace(re, `$1${v}$3`)
  }
  writeFileSync(join(dir, 'rules.ts'), lines.join('\n'))
  return (await import(pathToFileURL(join(dir, 'engine.ts')).href)).runEngine
}

/* ── live quote shape from minute bars (mirrors quotes.ts deriveVolumeMetrics) ── */
function volumeMetrics(ps: number[], vs: number[]): { rvol: number | null; vap: VAP | null; dollarVol: number | null } {
  const n = ps.length
  if (n < 8) return { rvol: null, vap: null, dollarVol: null }
  let tv = 0, dv = 0, lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) { tv += vs[i]; dv += vs[i] * ps[i]; if (ps[i] < lo) lo = ps[i]; if (ps[i] > hi) hi = ps[i] }
  const avg = tv / n
  let rv5 = 0; for (let i = n - 5; i < n; i++) rv5 += vs[i]
  const rvol = avg > 0 ? +((rv5 / 5) / avg).toFixed(3) : null
  let vap: VAP | null = null
  if (hi > lo) {
    const B = 20, size = (hi - lo) / B, bins = new Array(B).fill(0)
    for (let i = 0; i < n; i++) bins[Math.min(B - 1, Math.max(0, Math.floor((ps[i] - lo) / size)))] += vs[i]
    vap = { lo: +lo.toFixed(4), hi: +hi.toFixed(4), bins }
  }
  return { rvol, vap, dollarVol: Math.round(dv) }
}

/* ── load history once ── */
const all = loadAll()
const days = tradingDays(all)
if (days.length < 3) throw new Error(`Only ${days.length} usable days in data. Run npm run q:fetch.`)
const dayMaps: Record<string, Map<number, (Bar | null)[]>> = {}
for (const [s, b] of Object.entries(all)) dayMaps[s] = byDay(b)
function lastClose(sym: string, day: number): number | null {
  const a = dayMaps[sym]?.get(day); if (!a) return null
  for (let i = a.length - 1; i >= 0; i--) if (a[i]) return a[i]![4]
  return null
}

interface Result {
  label: string; sc: Score; first: Score; second: Score
  days: number; tradesPerDay: number; sharpe: number; maxDD: number; totalRetPct: number; spyRetPct: number
  greenPct: number; exposurePct: number
  byEntry: (Score & { sig: string })[]; byExit: (Score & { sig: string })[]
  rejects: [string, number][]; trades: any[]
  h10: { checks: number; belowFrozen: number; steppedDown: number; examples: string[] }
}

async function simulate(label: string, over: [string, string][]): Promise<Result> {
  const runEngine = await loadEngine(over)
  const realNow = Date.now
  let clock = etToUtc(days[1], 565) * 1000
  Date.now = () => clock
  let state = freshState(clock)
  let refs: EngineRefs = emptyRefs()
  const trades: any[] = []
  const rejects: Record<string, number> = {}
  const eq: number[] = []
  const entryOf: Record<string, string> = {}
  let expoSum = 0, expoN = 0
  /* H10 property check: on every tick, for every open position, the stop must
     (a) never be below the frozen stop set at entry, and (b) never move down
     while the position is open. Keyed by ticker + entry time so a re-entry
     starts fresh. */
  const h10 = { checks: 0, belowFrozen: 0, steppedDown: 0, examples: [] as string[] }
  const lastStop = new Map<string, number>()

  try {
    for (let di = 1; di < days.length; di++) {
      const d = days[di], prev = days[di - 1]
      const bars: Record<string, number[]> = {}
      const universe = [...new Set<string>([
        'SPY', 'QQQ', ...state.stocks, ...state.positions.map(p => p.ticker), ...state.roster, ...state.bench,
        ...(state.aiPicksStocks ? STOCK_LIBRARY.map(s => s.sym) : []), ...(!state.allIn ? SAFE_STOCKS : []),
      ])].filter(s => dayMaps[s]?.get(d))
      const prevClose: Record<string, number> = {}
      for (const s of universe) { const c = lastClose(s, prev); if (c) prevClose[s] = c }
      const ps: Record<string, number[]> = {}, vs: Record<string, number[]> = {}
      const hiLo: Record<string, [number, number]> = {}
      for (const s of universe) { ps[s] = []; vs[s] = [] }

      // premarket: one step, price = prior close (regularMarketPrice does not move pre)
      const steps: [number, 'premarket' | 'regular' | 'afterhours'][] = [[565, 'premarket']]
      for (let m = 571; m <= 959; m++) steps.push([m, 'regular'])
      for (let m = 960; m <= 998; m += 2) steps.push([m, 'afterhours'])

      for (const [m, session] of steps) {
        clock = etToUtc(d, m) * 1000 + 5000
        const k = Math.min(389, m - 571)  // last completed slot index
        if (session === 'regular') {
          for (const s of universe) {
            const b = dayMaps[s].get(d)![k]
            if (b) { ps[s].push(b[4]); vs[s].push(b[5]); const hl = hiLo[s]; hiLo[s] = hl ? [Math.max(hl[0], b[2]), Math.min(hl[1], b[3])] : [b[2], b[3]] }
          }
        }
        const quotes: Record<string, Quote> = {}
        for (const s of universe) {
          const pc = prevClose[s]; if (!pc) continue
          const price = ps[s].length ? ps[s][ps[s].length - 1] : pc
          const hl = hiLo[s] ?? [price, price]
          const vm = session === 'premarket' ? { rvol: null, vap: null, dollarVol: null } : volumeMetrics(ps[s], vs[s])
          quotes[s] = { price: +price.toFixed(2), changePct: +(((price - pc) / pc) * 100).toFixed(2), high: +hl[0].toFixed(2), low: +hl[1].toFixed(2), prevClose: +pc.toFixed(2), source: 'yahoo', ...vm }
        }
        for (const [s, q] of Object.entries(quotes)) {
          const a = bars[s] ?? (bars[s] = [])
          if (!a.length || a[a.length - 1] !== q.price) a.push(q.price)
          if (a.length > 120) a.shift()
        }
        const out = runEngine({ state, refs, quotes, bars, session, etMin: m })
        state = out.state; refs = out.refs
        for (const p of state.positions) {
          const k = `${p.ticker}|${p.entryTime}`, prev = lastStop.get(k)
          h10.checks++
          if (p.frozenStop != null && p.stopLevel < p.frozenStop - 1e-9) { h10.belowFrozen++; if (h10.examples.length < 5) h10.examples.push(`${p.ticker} d${d} ${m}: stop ${p.stopLevel} < frozen ${p.frozenStop}`) }
          if (prev != null && p.stopLevel < prev - 1e-9) { h10.steppedDown++; if (h10.examples.length < 5) h10.examples.push(`${p.ticker} d${d} ${m}: stop fell ${prev} -> ${p.stopLevel}`) }
          lastStop.set(k, p.stopLevel)
        }
        for (const [r, n] of Object.entries(out.rejects as Record<string, number>)) rejects[r] = (rejects[r] ?? 0) + n
        for (const t of out.newTrades as Trade[]) {
          if (t.action === 'BUY' && !/PYRAMID/.test(t.signal ?? '')) entryOf[t.ticker] = t.signal ?? 'UNKNOWN'
          trades.push({ ...t, day: d, etMin: m, entrySignal: t.action === 'SELL' ? (entryOf[t.ticker] ?? 'UNKNOWN') : t.signal })
        }
        if (session === 'regular') {
          const inv = state.positions.reduce((a, p) => a + p.value, 0)
          expoSum += state.totalValue > 0 ? inv / state.totalValue : 0; expoN++
        }
      }
      eq.push(state.totalValue)
    }
  } finally { Date.now = realNow }

  const sells = trades.filter(t => t.action === 'SELL' && t.pnl != null && t.sleeve !== 'SAFE')
  const half = days[1 + Math.floor((days.length - 1) / 2)]
  const rets = eq.map((v, i) => (v - (i ? eq[i - 1] : cfg.budget)) / (i ? eq[i - 1] : cfg.budget))
  const mu = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length)
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mu) ** 2, 0) / Math.max(1, rets.length - 1))
  let peak = cfg.budget, mdd = 0
  for (const v of eq) { peak = Math.max(peak, v); mdd = Math.max(mdd, (peak - v) / peak) }
  const spy0 = lastClose('SPY', days[0])!, spy1 = lastClose('SPY', days[days.length - 1])!
  const group = (key: 'entrySignal' | 'signal') => {
    const g: Record<string, any[]> = {}
    for (const t of sells) (g[t[key] ?? 'UNKNOWN'] ??= []).push(t)
    return Object.entries(g).map(([sig, rows]) => ({ sig, ...score(rows) })).sort((a, b) => a.net - b.net)
  }
  return {
    label, sc: score(sells),
    first: score(sells.filter(t => t.day < half)), second: score(sells.filter(t => t.day >= half)),
    days: eq.length, tradesPerDay: +(sells.length / Math.max(1, eq.length)).toFixed(1),
    sharpe: sd > 0 ? +((mu / sd) * Math.sqrt(252)).toFixed(2) : 0,
    maxDD: +(mdd * 100).toFixed(2),
    totalRetPct: +(((eq[eq.length - 1] ?? cfg.budget) / cfg.budget - 1) * 100).toFixed(3),
    spyRetPct: +((spy1 / spy0 - 1) * 100).toFixed(2),
    greenPct: +(100 * rets.filter(r => r > 0).length / Math.max(1, rets.length)).toFixed(1),
    exposurePct: +(100 * expoSum / Math.max(1, expoN)).toFixed(1),
    byEntry: group('entrySignal'), byExit: group('signal'),
    rejects: Object.entries(rejects).sort((a, b) => b[1] - a[1]).slice(0, 12),
    trades, h10,
  }
}

/* ── report ── */
const $ = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const pad = (s: any, n: number) => String(s).padStart(n)
function row(r: Result) {
  const s = r.sc
  return `${r.label.padEnd(34)}${pad(s.n, 6)}${pad(r.tradesPerDay, 6)}${pad(s.winRate + '%', 8)}${pad($(s.avgWin), 9)}${pad($(-s.avgLoss), 9)}${pad($(s.expectancy), 9)}${pad(s.profitFactor, 6)}${pad($(s.net), 10)}${pad($(s.netAfterCosts), 11)}${pad(r.sharpe, 7)}${pad(r.maxDD + '%', 7)}${pad(r.exposurePct + '%', 7)}${pad($(r.first.netAfterCosts), 10)}${pad($(r.second.netAfterCosts), 10)}`
}
const HEAD = `${'variant'.padEnd(34)}${pad('trades', 6)}${pad('/day', 6)}${pad('win', 8)}${pad('avgWin', 9)}${pad('avgLoss', 9)}${pad('$/trd', 9)}${pad('PF', 6)}${pad('net', 10)}${pad('aftCost', 11)}${pad('Sharpe', 7)}${pad('maxDD', 7)}${pad('expo', 7)}${pad('1stHalf', 10)}${pad('2ndHalf', 10)}`

function detail(r: Result) {
  console.log(`\n── ${r.label} ── ${r.days} days, Troy ${r.totalRetPct}% vs SPY buy-and-hold ${r.spyRetPct}%, ${r.greenPct}% green days`)
  console.log(`win rate ${r.sc.winRate}% | break-even win rate at this payoff ${r.sc.breakEvenWinRate}% | payoff ${r.sc.payoff}x`)
  const tbl = (title: string, rows: (Score & { sig: string })[]) => {
    console.log(`\n  ${title}`)
    for (const s of rows) console.log(`    ${s.sig.padEnd(26)} n=${pad(s.n, 4)}  win=${pad(s.winRate + '%', 7)}  $/trd=${pad($(s.expectancy), 8)}  net=${pad($(s.net), 9)}  aftCost=${pad($(s.netAfterCosts), 9)}`)
  }
  tbl('by ENTRY signal (worst first)', r.byEntry)
  tbl('by EXIT reason (worst first)', r.byExit)
  const h = r.h10
  console.log(`\n  H10 check (stop never below frozen, never steps down): ${h.checks} position-ticks, ${h.belowFrozen} below frozen, ${h.steppedDown} stepped down -> ${h.belowFrozen + h.steppedDown === 0 ? 'PASS' : 'FAIL'}${h.examples.length ? '\n    ' + h.examples.join('\n    ') : ''}`)
  console.log(`\n  top entry rejections: ${r.rejects.map(([k, v]) => `${k}=${v}`).join('  ')}`)
}

const runs: [string, [string, string][]][] = [['baseline (deployed rules)', []]]
if (sets.length) runs.push([sets.map(([k, v]) => `${k}=${v}`).join(' '), sets])
for (const [k, vals] of sweeps) for (const v of vals) runs.push([`${k}=${v}`, [...sets, [k, v]]])

console.log(`Backtesting ${days.length - 1} days (${Object.keys(all).length} symbols), budget ${$(cfg.budget)}, router ${cfg.regimeRouter}, allIn ${cfg.allIn}\n`)
const results: Result[] = []
for (const [label, over] of runs) {
  process.stdout.write(`running ${label}... `)
  const t0 = performance.now()
  results.push(await simulate(label, over))
  console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s`)
}
console.log(`\n${HEAD}\n${'-'.repeat(HEAD.length)}`)
for (const r of results) console.log(row(r))
console.log(`\nnet/aftCost = all closed trades in $. 1stHalf/2ndHalf = after-cost net in each half of the period. A real edge shows up in BOTH halves.`)
for (const r of results) detail(r)
if (printTrades) for (const r of results) {
  console.log(`\n── trades: ${r.label} ──`)
  for (const t of r.trades) console.log(`  d${t.day} ${String(Math.floor(t.etMin / 60)).padStart(2, '0')}:${String(t.etMin % 60).padStart(2, '0')} ${t.action.padEnd(4)} ${t.ticker.padEnd(6)} $${t.price.toFixed(2).padStart(9)} ${t.pnl != null ? $(t.pnl).padStart(8) : ''.padStart(8)}  ${t.signal}`)
}
mkdirSync(OUT, { recursive: true })
const file = join(OUT, `backtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(results, null, 1))
console.log(`\nSaved ${file}`)
