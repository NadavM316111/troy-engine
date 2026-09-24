/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE — the browser's runTradingEngine, as a pure function.

   Browser version:  setPortfolio(prev => ...) plus a dozen useRefs.
   Server version:   (state, refs, quotes, bars) => { state, refs, trades, ... }

   Same rules, same order of operations. The only structural change is that
   nothing mutates outside the return value, which makes the whole thing
   testable and makes a crashed tick unable to leave a half-written portfolio.
   ═══════════════════════════════════════════════════════════════════════════ */

import type {
  DayName, DaySummary, EngineRefs, MarketSession, PortfolioState, Position, Quote, Regime, Trade,
} from './types.js'
import {
  buildVolumeProfile, calcATR, ss42Slice, fmtShares, vwapProxy, MIN_SLICE, FRACTIONAL_DECIMALS,
} from './indicators.js'
import * as R from './rules.js'
import { etDateISO, etDateLabel, etDayKey, tsEtDayKey, marketHalt } from './quotes.js'

export interface EngineInput {
  state: PortfolioState
  refs: EngineRefs
  quotes: Record<string, Quote>
  bars: Record<string, number[]>
  session: MarketSession
  etMin: number
}

export interface EngineOutput {
  state: PortfolioState
  refs: EngineRefs
  newTrades: Trade[]
  execLog: string[]
  notifications: string[]
  /* Why entries were rejected this tick, keyed by reason. Without this the only
     visible symptom of a too-tight filter is "no trades", which is also exactly
     what a genuinely quiet market looks like. They are not the same thing and
     this is the only way to tell them apart. */
  rejects: Record<string, number>
  gate: { maxConcurrent: number; held: number; scanOnly: boolean; noTrade: boolean; cautiousRed: boolean; window: string; spy: number; breadth: number; relax: number }
}

function genId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` }

export function runEngine(input: EngineInput): EngineOutput {
  const { quotes, bars, session, etMin } = input
  const cp = input.state
  const refs: EngineRefs = JSON.parse(JSON.stringify(input.refs))
  const notifications: string[] = []
  const execLog: string[] = []
  const newTrades: Trade[] = []
  const rejects: Record<string, number> = {}
  const rej = (k: string) => { rejects[k] = (rejects[k] ?? 0) + 1 }

  if (cp.withdrawn) return { state: cp, refs, newTrades, execLog, notifications, rejects, gate: { maxConcurrent: 0, held: 0, scanOnly: false, noTrade: false, cautiousRed: false, window: 'n/a', spy: 0, breadth: 0, relax: 1 } }

  let positions: Position[] = JSON.parse(JSON.stringify(cp.positions))
  let cash = cp.cash
  let realized = cp.realizedPnl
  let wins = 0, losses = 0

  const totalValue = cash + positions.reduce((s, p) => s + p.value, 0)
  const returnPct = totalValue > 0 ? ((totalValue - cp.budget) / cp.budget) * 100 : 0
  const targetPct = cp.targetReturn
  const spyChange = quotes['SPY']?.changePct ?? quotes['QQQ']?.changePct ?? 0
  const { halted: marketHalted } = marketHalt(quotes)

  const inFlatten  = session === 'regular' && etMin >= R.SS51_FLATTEN_MIN
  const noNewEntry = session === 'regular' && etMin >= R.SS51_NO_ENTRY_MIN
  const defensiveMode = spyChange < -0.3 && !marketHalted
  const intraWindow = R.ss61Window(etMin)
  const ss61m = R.ss61Mults(intraWindow)

  const router = cp.regimeRouter === true
  const scanOnly = router && ((session === 'regular' && etMin < R.SS53_START_MIN) || session === 'premarket')
  const beastToggle = cp.beastMode === true
  const bnames = Object.keys(quotes).filter(s => s !== 'SPY' && !R.SAFE_STOCKS.includes(s))
  const greenFrac = bnames.length ? bnames.filter(s => (quotes[s]?.changePct ?? 0) > 0).length / bnames.length : 0
  const universeDefect = R.ss54UniverseDefect(quotes)

  let ledger = [...(cp.lessonsLedger ?? [])]
  let lastReviewDay = cp.lastReviewDay ?? 0
  let regime = (cp.regime ?? 'PENDING') as PortfolioState['regime']
  let activeMode = cp.activeMode ?? 'PENDING'
  let roster = [...(cp.roster ?? [])]
  let bench = [...(cp.bench ?? [])]
  let switchBudget = cp.switchBudget ?? 0
  let beastLockedOut = cp.beastLockedOut ?? false
  let lastRegimeEvalMin = cp.lastRegimeEvalMin ?? 0

  /* ── SS53 regime router ── */
  if (router && session === 'regular' && etMin >= R.SS53_START_MIN && !inFlatten) {
    if (activeMode === 'PENDING' || (etMin - lastRegimeEvalMin) >= R.SS53_REEVAL_MIN) {
      const watch = cp.aiPicksStocks ? [...new Set([...cp.stocks, ...R.STOCK_LIBRARY.map(s => s.sym)])] : cp.stocks
      const ranked = R.rankCandidates(watch, quotes, bars, spyChange, targetPct, returnPct)
      const newRegime: Regime = marketHalted ? 'FULL_RED' : R.classifyRegime(spyChange, greenFrac, ranked.length)
      let desired: PortfolioState['activeMode']
      if (newRegime === 'FULL_RED') desired = 'NO_TRADE'
      else if (newRegime === 'MIXED_RED') desired = 'ALGO_X'
      else if (newRegime === 'SEMI_GREEN') desired = (beastToggle && !beastLockedOut) ? 'BEAST' : 'ALGO_X'
      else desired = (beastToggle && !beastLockedOut) ? (ranked.length >= R.RG_FULLGREEN_DUALCONF ? 'BEAST_PLUS' : 'BEAST') : 'ALGO_X'
      const prevRank = R.REGIME_RANK[(regime === 'PENDING' ? newRegime : regime) as Regime]
      const upgrade = R.REGIME_RANK[newRegime] > prevRank && activeMode !== 'PENDING'
      let apply = true
      if (upgrade && (desired === 'BEAST' || desired === 'BEAST_PLUS') && etMin > R.SS53_BEAST_UPGRADE_CUTOFF) apply = false
      if (apply) {
        regime = newRegime
        if (marketHalted) beastLockedOut = true
        if (beastLockedOut && (desired === 'BEAST' || desired === 'BEAST_PLUS')) desired = 'ALGO_X'
        if (desired === 'BEAST' || desired === 'BEAST_PLUS') {
          const size = desired === 'BEAST_PLUS' ? R.ROSTER_SIZE_BEASTPLUS : R.ROSTER_SIZE_BEAST
          const keep = roster.filter(s => ranked.includes(s)).slice(0, size)
          const fill = ranked.filter(s => !keep.includes(s))
          const wasBeast = activeMode === 'BEAST' || activeMode === 'BEAST_PLUS'
          roster = [...keep, ...fill].slice(0, size)
          bench = ranked.filter(s => !roster.includes(s)).slice(0, 3)
          if (!wasBeast) switchBudget = desired === 'BEAST_PLUS' ? R.SWITCH_BUDGET_BEASTPLUS : R.SWITCH_BUDGET_BEAST
        } else { roster = []; bench = [] }
        activeMode = desired
      }
      lastRegimeEvalMin = etMin
    }
  } else if (!router) { activeMode = 'ALGO_X'; regime = 'PENDING' }

  const inBeastRoute = router && (activeMode === 'BEAST' || activeMode === 'BEAST_PLUS')
  const noTradeRoute = router && activeMode === 'NO_TRADE'
  const cautiousRed  = router && activeMode === 'ALGO_X' && regime === 'MIXED_RED'
  const beast = router ? inBeastRoute : beastToggle

  /* FULL_GREEN relaxation: on a genuinely strong tape the entry bars ease 5%.
     Everywhere else this is 1, so it can never loosen a red or mixed day. It
     touches confidence bars and the SS62 volume threshold only — never stops,
     exits, sizing or any risk cap. */
  const relax = regime === 'FULL_GREEN' ? R.RG_FULLGREEN_RELAX : 1

  const safeBudget = (cp.allIn || beast) ? 0 : cp.budget * (cp.safeAlloc / 100)
  const sleeve = (cp.allIn || beast) ? cp.budget : cp.budget * (cp.riskAlloc / 100)

  let maxConcurrent = marketHalted ? 0 : beast ? R.BEAST_MAX_CONCURRENT : defensiveMode ? R.MAX_CONCURRENT_DEFENSIVE : (cp.zangerMode ? R.ZANGER_MAX_CONCURRENT : R.MAX_CONCURRENT_NORMAL)
  if (inBeastRoute) maxConcurrent = activeMode === 'BEAST_PLUS' ? R.ROSTER_SIZE_BEASTPLUS : R.ROSTER_SIZE_BEAST
  if (cautiousRed) maxConcurrent = Math.min(maxConcurrent, R.MAX_CONCURRENT_DEFENSIVE)
  if (noTradeRoute || scanOnly) maxConcurrent = 0

  const sellPosition = (pos: Position, price: number, reason: string, signal: string, conviction: Trade['conviction']) => {
    const proceeds = pos.shares * price, pnl = (price - pos.avgPrice) * pos.shares
    const rtPct = pos.avgPrice > 0 ? (price - pos.avgPrice) / pos.avgPrice : 0
    cash += proceeds; realized += pnl
    if (pnl > 0) wins++; else { losses++; refs.dropStrike[pos.ticker] = (refs.dropStrike[pos.ticker] ?? 0) + 1 }
    refs.cooldown[pos.ticker] = Date.now()
    if (Math.abs(rtPct) <= R.SCRATCH_BAND) {
      const s = refs.scratch[pos.ticker] ?? { count: 0, frozenUntil: 0 }
      s.count += 1; if (s.count > R.SCRATCH_MAX) s.frozenUntil = Date.now() + R.SCRATCH_FREEZE_MS
      refs.scratch[pos.ticker] = s
    }
    positions = positions.filter(p => p.ticker !== pos.ticker)
    newTrades.push({ id: genId(), ticker: pos.ticker, action: 'SELL', shares: pos.shares, price, total: proceeds, reasoning: reason, timestamp: Date.now(), pnl, conviction, signal, sleeve: pos.isSafe ? 'SAFE' : 'MAIN' })
  }

  /* ── SS51 flatten ── */
  if (inFlatten && positions.length) {
    const ordered = [...positions].sort((a, b) => b.value - a.value)
    for (const pos of ordered) {
      const price = quotes[pos.ticker]?.price ?? pos.currentPrice
      sellPosition(pos, price, `SS51 FLAT: end-of-day flatten (${etMin >= R.SS51_HARD_MIN ? 'hard deadline' : 'flatten window'}). No overnight exposure.`, 'SS51_FLAT', 'HIGH')
      execLog.push(`FLAT ${pos.ticker} @ $${price.toFixed(2)}`)
    }
    notifications.push(`End-of-day flatten — ${ordered.length} position${ordered.length !== 1 ? 's' : ''} closed`)
    refs.gStock = []; refs.fkStrike = {}; refs.fkLock = {}; refs.dropStrike = {}; refs.ss62Bump = {}; refs.ss62Block = {}
  }

  /* ── SS56 flat assert ── */
  if (session === 'regular' && etMin >= R.SS56_FLAT_ASSERT_MIN && positions.length) {
    for (const pos of [...positions]) {
      const price = quotes[pos.ticker]?.price ?? pos.currentPrice
      sellPosition(pos, price, `SS56 FLAT ASSERT: residue at 15:58 — emergency liquidation.`, 'SS56_FLAT_ASSERT', 'HIGH')
      execLog.push(`FLAT-ASSERT ${pos.ticker}`)
    }
    notifications.push('SS56 flat-assert fired — residue force-closed')
  }

  /* ── SS37 exit pass ── */
  if (!inFlatten) for (const pos of cp.positions) {
    if (!positions.find(p => p.ticker === pos.ticker)) continue
    const q = quotes[pos.ticker]; if (!q || q.price <= 0) continue
    const b = bars[pos.ticker] || [pos.currentPrice]
    const price = q.price
    const newPeak = Math.max(pos.highWatermark, price)

    if (beast && !pos.isSafe) {
      const floorLine = pos.avgPrice * (1 - R.SS59_FLOOR_PCT)
      const hardLine  = pos.avgPrice * (1 - R.SS59_HARD_PCT)
      const touched   = pos.floorTouchedAt ?? 0
      if (price <= hardLine) {
        sellPosition(pos, price, `SS59 HARD: -0.50% breached ($${hardLine.toFixed(2)}) — grace void, instant exit.`, 'SS59_HARD', 'HIGH')
        refs.a2Strike[pos.ticker] = (refs.a2Strike[pos.ticker] ?? 0) + 1
        execLog.push(`HARD ${pos.ticker}`); notifications.push(`${pos.ticker} -0.5% instant sell`)
        continue
      }
      if (price <= floorLine) {
        if (!touched) {
          positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, floorTouchedAt: Date.now(), currentPrice: price })
          notifications.push(`${pos.ticker} at -0.3%, 30s to recover`)
          continue
        }
        if (Date.now() - touched >= R.SS59_GRACE_MS) {
          sellPosition(pos, price, `SS59 floor: -0.30% line held for 30s with no recovery. Small loss, capital freed.`, 'SS59_FLOOR', 'HIGH')
          refs.a2Strike[pos.ticker] = (refs.a2Strike[pos.ticker] ?? 0) + 1
          execLog.push(`FLOOR ${pos.ticker}`)
          continue
        }
        continue
      }
      if (touched) positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, floorTouchedAt: 0 })
      const r = R.ss58Tick(pos, price, q.changePct, b, calcATR(b))
      positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, bandLine: r.bandLine, sellLine: r.sellLine, escalated: r.escalated, escUsed: r.escUsed, escDeadline: r.escDeadline })
      if (r.sell) {
        if (r.gEarned && !refs.gStock.includes(pos.ticker)) refs.gStock.push(pos.ticker)
        sellPosition(pos, price, r.reason, r.gEarned ? 'SS58_GSTOCK' : 'SS58_BAND', 'HIGH')
        execLog.push(`${r.gEarned ? 'G-STOCK' : 'BAND'} ${pos.ticker}`)
        notifications.push(`${pos.ticker} +${(((price-pos.avgPrice)/pos.avgPrice)*100).toFixed(2)}% banked`)
        continue
      }
    }

    if (cp.zangerMode && pos.isZanger && !pos.partialDone) {
      const pv = pos.pivot ?? pos.avgPrice
      const failedFast = (Date.now() - pos.entryTime <= R.ZANGER_FAIL_FAST_MS) && price < pv
      const belowTight = price <= Math.max(pos.stopLevel, pos.avgPrice * (1 - R.ZANGER_FAIL_STOP_PCT))
      if (failedFast || belowTight) {
        sellPosition(pos, price, `SS52 Zanger failed breakout: back below pivot $${pv.toFixed(2)} — tight -2% cut.`, 'SS52_ZANGER_FAIL', 'HIGH')
        execLog.push(`ZFAIL ${pos.ticker}`)
        continue
      }
    }

    const ss37 = R.ss37Tick({ ...pos, highWatermark: newPeak }, price)

    if (ss37.action === 'PARTIAL_BANK') {
      const sellShares = +(pos.shares / 3).toFixed(FRACTIONAL_DECIMALS)
      const keep = +(pos.shares - sellShares).toFixed(FRACTIONAL_DECIMALS)
      const proceeds = sellShares * price, pnl = (price - pos.avgPrice) * sellShares
      cash += proceeds; realized += pnl; if (pnl > 0) wins++; else losses++
      newTrades.push({ id: genId(), ticker: pos.ticker, action: 'SELL', shares: sellShares, price, total: proceeds, reasoning: ss37.reasoning, timestamp: Date.now(), pnl, conviction: 'HIGH', signal: ss37.signal, sleeve: 'MAIN' })
      execLog.push(`BANK ${pos.ticker} 1/3`)
      notifications.push(`${pos.ticker} +${(((price-pos.avgPrice)/pos.avgPrice)*100).toFixed(1)}% — banked, runner live`)
      positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, shares: keep, value: keep*price, pnl: keep*(price-p.avgPrice), pnlPct: ((price-p.avgPrice)/p.avgPrice)*100, currentPrice: price, highWatermark: newPeak, partialDone: true, stopLevel: ss37.updatedStopLevel, bars: b.slice(-20), peakSince: Date.now(), preTrailLow: Math.min(...b.slice(-6)) })
      continue
    }
    if (ss37.action === 'STOP' || ss37.action === 'RUNNER_STOP') {
      sellPosition(pos, price, ss37.reasoning, ss37.signal, ss37.action === 'RUNNER_STOP' ? 'HIGH' : 'MEDIUM')
      execLog.push(`EXIT ${pos.ticker} (${ss37.signal})`)
      continue
    }

    const h4 = R.ss50H4TopExit({ ...pos, highWatermark: newPeak }, price)
    if (h4.exit) { sellPosition(pos, price, h4.reason, 'SS50_H4_CTE', 'HIGH'); execLog.push(`H4 ${pos.ticker}`); continue }

    if (!pos.isSafe) {
      const age = Date.now() - pos.entryTime
      const gain = (price - pos.avgPrice) / pos.avgPrice
      const extended = pos.benchExtended === true
      const deadline = R.SS55_HOUR_MS + (extended ? R.SS55_EXTEND_MS : 0)
      if (age >= R.SS55_HOUR_MS && gain < R.SS55_BENCH_PCT) {
        if (!extended && R.ss55Linear(b)) {
          positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, benchExtended: true, currentPrice: price, value: p.shares*price, pnl: p.shares*(price-p.avgPrice), pnlPct: gain*100 })
          notifications.push(`${pos.ticker} +30min (linear climb)`)
          continue
        }
        if (age >= deadline) {
          sellPosition(pos, price, `SS55 hourly benchmark: no +0.10% in ${extended?'90':'60'} min (${(gain*100).toFixed(2)}%). Rotating capital.`, 'SS55_BENCH', 'MEDIUM')
          execLog.push(`BENCH ${pos.ticker}`)
          continue
        }
      }
    }

    const entry = pos.avgPrice
    const mfe = Math.max(pos.maxFavorable ?? 0, ((price-entry)/entry)*100)
    let weakSince = pos.weakSince ?? 0
    const preS2 = !pos.partialDone && price < entry * 1.05
    if (preS2 && !pos.isSafe) {
      const weakNow = price < entry && price < vwapProxy(b)
      if (weakNow) {
        if (!weakSince) weakSince = Date.now()
        else if (Date.now() - weakSince >= R.DEAD_WEAK_MS) {
          sellPosition(pos, price, `SS43 DEAD_WEAK: below entry & VWAP sustained. Thesis failed; recycling capital.`, 'DEAD_WEAK', 'MEDIUM')
          execLog.push(`DEAD_WEAK ${pos.ticker}`)
          continue
        }
      } else weakSince = 0
    } else weakSince = 0

    const newPreTrailLow = pos.partialDone && price >= pos.highWatermark ? Math.min(...b.slice(-6)) : pos.preTrailLow
    positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, currentPrice: price, value: p.shares*price, pnl: p.shares*(price-p.avgPrice), pnlPct: ((price-p.avgPrice)/p.avgPrice)*100, highWatermark: newPeak, stopLevel: Math.max(p.stopLevel, ss37.updatedStopLevel, p.frozenStop ?? 0), bars: b.slice(-20), maxFavorable: mfe, weakSince, peakSince: newPeak > pos.highWatermark ? Date.now() : pos.peakSince, preTrailLow: newPreTrailLow })
  }

  /* ── SS52 focus switch ── */
  if (router && (activeMode === 'BEAST' || activeMode === 'BEAST_PLUS') && !inFlatten && !scanOnly) {
    const bucket = Math.floor(etMin / 5)
    if (bucket !== refs.candleBucket) {
      refs.candleBucket = bucket
      const thr = regime === 'FULL_GREEN' ? R.SWITCH_THRESH_FULLGREEN : regime === 'SEMI_GREEN' ? R.SWITCH_THRESH_SEMIGREEN : R.SWITCH_THRESH_DOWNGRADE
      let failures = 0
      for (const sym of [...roster]) {
        const pos = positions.find(p => p.ticker === sym && !p.isSafe); if (!pos) continue
        const q = quotes[sym]; if (!q || q.price <= 0) continue
        if (R.ss52SwitchTrigger(pos, q.price, vwapProxy(bars[sym] || []), spyChange, q.changePct, thr)) {
          sellPosition(pos, q.price, `SS52 focus-switch: ${sym} failed (drop > ${(thr*100).toFixed(2)}%, below VWAP, weak vs SPY).`, 'SS52_SWITCH', 'MEDIUM')
          execLog.push(`SWITCH ${sym}`); failures++
          const repl = bench.find(bn => { const bq = quotes[bn]; return bq && bq.price > 0 && (bq.changePct - spyChange) > 0 && bq.price > vwapProxy(bars[bn] || []) })
          roster = roster.filter(r => r !== sym)
          bench = bench.filter(bn => bn !== repl)
          if (repl) { roster.push(repl); notifications.push(`Switched ${sym} to ${repl}`) }
          switchBudget = Math.max(0, switchBudget - 1)
        }
      }
      if (switchBudget <= 0 || failures >= 2) { activeMode = 'ALGO_X'; roster = []; bench = []; notifications.push('Beast de-moded to Algorithm X') }
    }
  }

  /* ── Safe allocation ── */
    if (session === 'regular' && !cp.allIn && safeBudget > 0 && !noNewEntry && !inFlatten && !scanOnly && !noTradeRoute && !universeDefect) {
    const safePosns = positions.filter(p => p.isSafe)
    const needed = Math.max(0, safeBudget - safePosns.reduce((s, p) => s + p.value, 0))
    if (needed > MIN_SLICE && cash > MIN_SLICE * 2) {
      for (const sym of R.SAFE_STOCKS) {
        if (safePosns.find(p => p.ticker === sym)) continue
        const q = quotes[sym]; if (!q || q.price <= 0) continue
        const b = bars[sym] || []; if (b.length < 3) continue
        const fc = cash / Math.max(1, cash + positions.reduce((s,p)=>s+p.value,0)) * 100
        const sig = R.troyBaseline(b, fc, targetPct, returnPct, session, true)
        if (sig.action === 'BUY' && sig.confidence >= 60) {
          const spend = Math.min(needed, cash * 0.4, Math.max(0, cash - safeBudget * 0.3))
          const { shares, filled } = ss42Slice(spend, q.price)
          if (shares <= 0 || filled > cash * 0.9) continue
          positions.push({ ticker: sym, shares, entryShares: shares, avgPrice: q.price, currentPrice: q.price, value: filled, pnl: 0, pnlPct: 0, sector: R.sectorOf(sym), stopLevel: q.price*0.97, targetPrice: q.price*1.15, highWatermark: q.price, partialDone: false, entryTime: Date.now(), bars: b.slice(-20), isSafe: true, entrySignal: sig.signal, maxFavorable: 0, weakSince: 0, frozenStop: q.price*0.97, benchExtended: false })
          cash -= filled
          newTrades.push({ id: genId(), ticker: sym, action: 'BUY', shares, price: q.price, total: filled, reasoning: `Safe alloc: ${sig.reasoning}`, timestamp: Date.now(), conviction: 'MEDIUM', signal: `SAFE_${sig.signal}`, sleeve: 'SAFE' })
          execLog.push(`SAFE BUY ${sym}`)
          break
        }
      }
    }
  }

  /* ── Pyramiding ── */
  if ((cp.zangerMode || beast) && !marketHalted && !noNewEntry && !inFlatten && !scanOnly && !noTradeRoute && spyChange > 0.05) {
    const maxPyr  = beast ? R.BEAST_MAX_PYRAMIDS : R.ZANGER_MAX_PYRAMIDS
    const pyrTrig = beast ? R.BEAST_PYRAMID_TRIGGER : R.ZANGER_PYRAMID_TRIGGER
    const riskNow = positions.filter(p => !p.isSafe)
    let deployedP = riskNow.reduce((s,p)=>s+p.value,0)
    let openRiskP = riskNow.reduce((s,p)=>s+Math.max(0,(p.currentPrice-p.stopLevel)*p.shares),0)
    for (const pos of positions.filter(p => (p.isZanger || beast) && !p.isSafe)) {
      if ((pos.pyramids ?? 0) >= maxPyr) continue
      const q = quotes[pos.ticker]; if (!q || q.price <= 0) continue
      const gain = (q.price - pos.avgPrice) / pos.avgPrice
      if (gain < pyrTrig || q.price < pos.highWatermark) continue
      const addAllocPct = (beast ? R.BEAST_PER_NAME_CAP_PCT : R.ZANGER_PER_NAME_CAP_PCT) * 0.5
      const maxSpend = R.ss16MaxSpend(sleeve, deployedP, cash, addAllocPct, openRiskP, beast)
      if (maxSpend < MIN_SLICE) continue
      const { shares: addSh, filled: addFill } = ss42Slice(maxSpend, q.price)
      if (addSh <= 0 || addFill > cash * (beast ? 0.99 : 0.92)) continue
      const newShares = +(pos.shares + addSh).toFixed(FRACTIONAL_DECIMALS)
      const newAvg = (pos.avgPrice * pos.shares + q.price * addSh) / newShares
      const raisedStop = Math.max(pos.stopLevel, pos.avgPrice)
      const addRisk = Math.max(0, (q.price - raisedStop) * addSh)
      if (openRiskP + addRisk > sleeve * (beast ? R.BEAST_RISK_BUDGET_PCT : 0.03)) continue
      cash -= addFill; deployedP += addFill; openRiskP += addRisk
      positions = positions.map(p => p.ticker !== pos.ticker ? p : { ...p, shares: newShares, avgPrice: +newAvg.toFixed(4), value: newShares*q.price, currentPrice: q.price, stopLevel: raisedStop, pyramids: (p.pyramids ?? 0) + 1 })
      newTrades.push({ id: genId(), ticker: pos.ticker, action: 'BUY', shares: addSh, price: q.price, total: addFill, reasoning: `${beast?'BEAST':'SS52 Zanger'} pyramid #${(pos.pyramids ?? 0)+1}: pressing a working move (+${(gain*100).toFixed(1)}%, new high). Stop raised to $${raisedStop.toFixed(2)}.`, timestamp: Date.now(), conviction: 'HIGH', signal: beast ? 'BEAST_PYRAMID' : 'SS52_ZANGER_PYRAMID', sleeve: 'MAIN' })
      execLog.push(`PYRAMID ${pos.ticker}`)
    }
  }

  /* ── Risk allocation (entries) ── */
  if (marketHalted)    rej('BLOCKED_marketHalt')
  if (noNewEntry)      rej('BLOCKED_eodCutoff')
  if (inFlatten)       rej('BLOCKED_flatten')
  if (scanOnly)        rej('BLOCKED_scanOnlyBefore1030')
  if (noTradeRoute)    rej('BLOCKED_fullRedStandDown')
  if (universeDefect)  rej('BLOCKED_universeDefect')
  if (!marketHalted && !noNewEntry && !inFlatten && !scanOnly && !noTradeRoute && !universeDefect) {
    const fullWatch = cp.aiPicksStocks ? [...new Set([...cp.stocks, ...R.STOCK_LIBRARY.map(s => s.sym)])] : cp.stocks
    const watchlist = inBeastRoute ? (roster.length ? roster : fullWatch) : fullWatch
    const riskPosns = positions.filter(p => !p.isSafe)
    let deployed = riskPosns.reduce((s,p)=>s+p.value,0)
    let openRisk = riskPosns.reduce((s,p)=>s+Math.max(0,(p.currentPrice-p.stopLevel)*p.shares),0)
    const perNameCapPct = beast ? R.BEAST_PER_NAME_CAP_PCT : cp.zangerMode ? R.ZANGER_PER_NAME_CAP_PCT : Math.max(6, 100 / maxConcurrent)

    if (riskPosns.length >= maxConcurrent) rej('maxConcurrentReached')
    if (riskPosns.length < maxConcurrent) {
      for (const sym of watchlist) {
        if (positions.find(p => p.ticker === sym)) continue
        if (positions.filter(p => !p.isSafe).length >= maxConcurrent) break
        const cdWindow = beast ? (refs.gStock.includes(sym) ? 0 : R.SS58_REENTRY_MS) : R.SYMBOL_COOLDOWN_MS
        if (Date.now() - (refs.cooldown[sym] ?? 0) < cdWindow) { rej('cooldown'); continue }
        if ((refs.fkLock[sym] ?? 0) > Date.now()) { rej('fallingKnifeLock'); continue }
        if ((refs.handicap[sym] ?? 0) > Date.now()) { rej('handicapped'); continue }
        if ((refs.a2Strike[sym] ?? 0) >= R.SS61_A2_STRIKES && !beast) { rej('a2Strikes'); continue }
        const scr = refs.scratch[sym]; if (scr && scr.frozenUntil > Date.now()) { rej('scratchFrozen'); continue }
        const q = quotes[sym]; if (!q || q.price <= 0) { rej('noQuote'); continue }
        if (q.changePct < (beast ? -5 : -1.5)) { rej('tooRed'); continue }
        if (R.SS54_EXCLUDE.includes(sym)) { rej('isIndexETF'); continue }
        const b = bars[sym] || []; if (b.length < 4) { rej('insufficientBars'); continue }

        const sector = R.sectorOf(sym)
        if (!R.ss54SectorGreen(sector, quotes, spyChange)) { rej('sectorNotGreen'); continue }
        if ((q.changePct - spyChange) < R.SS54_SYMBOL_RS_FLOOR) { rej('rsBelowSpy'); continue }
        const clusterPos = positions.filter(p => !p.isSafe && p.sector === sector)
        if (!beast && clusterPos.length >= R.CLUSTER_MAX_POS) { rej('sectorClusterFull'); continue }

        const freshTotal = cash + positions.reduce((s,p)=>s+p.value,0)
        const freshCashPct = freshTotal > 0 ? (cash / freshTotal) * 100 : 100
        const atr = calcATR(b), vp = buildVolumeProfile(b)

        let entryBuy = false, sigName = '', reason = '', initStop = q.price*0.97, target = q.price*1.05, allocPct = 18
        let zPivot: number | undefined

        if (cp.zangerMode && spyChange > 0.05 && session === 'regular' && b.length >= R.ZANGER_BASE_MIN_BARS + 3) {
          const z = R.ss52ZangerBreakout(b, q.price)
          if (z) { entryBuy = true; sigName = `SS52_ZANGER_${z.grade}`; reason = z.reason; initStop = z.stop; zPivot = z.pivot; target = q.price*(1+Math.max(0.06, targetPct/100)); allocPct = z.grade === 'A' ? R.ZANGER_PER_NAME_CAP_PCT : 16 }
        }
        if (!entryBuy && session === 'regular' && b.length >= 8) {
          if (refs.orb[sym] === undefined) refs.orb[sym] = R.buildORB(b)
          const orb = refs.orb[sym]
          if (orb) { const s = R.ss38Signal(b, q.price, atr, vp, orb); if (s) { entryBuy = true; sigName = `SS38_ORB_${s.grade}`; reason = s.reason; initStop = s.stop; target = s.target; allocPct = s.grade === 'A' ? 22 : 16; orb.attempts++ } }
        }
        if (!entryBuy && b.length >= 14) {
          if (!refs.ss39[sym]) refs.ss39[sym] = { state: 'WAIT_BREAK', level: 0, side: null, barsSince: 0, retestLow: q.price, retestHigh: q.price }
          const r = R.ss39Step(b, refs.ss39[sym], atr, vp); refs.ss39[sym] = r.newCtx
          if (r.entry) { entryBuy = true; sigName = 'SS39_BREAK_RETEST'; reason = r.reason; initStop = r.stop; target = r.target; allocPct = 20 }
        }
        if (!entryBuy) {
          const s = R.troyBaseline(b, freshCashPct, targetPct, returnPct, session, false)
          if (s.action === 'BUY' && s.confidence >= (beast ? R.BEAST_BASELINE_CONF : 63) * relax) { entryBuy = true; sigName = s.signal; reason = s.reasoning; allocPct = s.allocPct }
        }

        if (!entryBuy) { rej('noSignal'); continue }

        const g62 = R.ss62Gate(q, q.price, intraWindow, beast, etMin, refs.ss62Bump[sym] ?? 0, relax)
        if (!g62.pass) {
          rej(`ss62:${g62.reason.split(' ')[0]}`); refs.ss62Count++
          const cb = (refs.ss62Block[sym] ?? 0) + 1
          refs.ss62Block[sym] = cb
          if (cb >= R.SS62_LANE1_AFTER) refs.ss62Bump[sym] = (refs.ss62Bump[sym] ?? 0) + R.SS62_LANE1_BUMP
          continue
        }
        refs.ss62Block[sym] = 0

        const drops = refs.dropStrike[sym] ?? 0
        if (drops >= R.REPEAT_DROP_STRIKES) {
          if (R.ss59DownOnly(b)) { rej('repeatDropper_downOnly'); continue }
          const hp = R.troyBaseline(b, freshCashPct, targetPct, returnPct, session, false)
          const strong = sigName.startsWith('SS38') || sigName.startsWith('SS39') || sigName.startsWith('SS52')
          if (!strong && !(hp.action === 'BUY' && hp.confidence >= R.REPEAT_DROP_CONF)) { rej('repeatDropper_conf'); continue }
        }
        if (cautiousRed) {
          const cq = R.troyBaseline(b, freshCashPct, targetPct, returnPct, session, false)
          if (!(cq.action === 'BUY' && cq.confidence >= 75) && !sigName.startsWith('SS38') && !sigName.startsWith('SS39')) { rej('cautiousRed_bar75'); continue }
        }
        if (intraWindow === 'PRE' || intraWindow === 'FLAT') { rej(`window_${intraWindow}`); continue }
        if (ss61m.sig > 1.0) {
          const rv = R.ss61RvProxy(b)
          if (rv !== null && rv < ss61m.rv) { rej(`ss61_rv_${intraWindow}`); continue }
          const bar = (beast ? R.BEAST_BASELINE_CONF : 63) * ss61m.sig * relax
          const s = R.troyBaseline(b, freshCashPct, targetPct, returnPct, session, false)
          if (!(s.action === 'BUY' && s.confidence >= bar) && !sigName.startsWith('SS38') && !sigName.startsWith('SS39')) { rej(`ss61_sig_${intraWindow}`); continue }
        }

        if (initStop >= q.price || initStop <= 0) initStop = q.price * 0.97
        if (target <= q.price) target = q.price * (1 + (targetPct/100) * 0.6)
        const cappedAlloc = beast ? (100 / maxConcurrent) : Math.min(allocPct, perNameCapPct)
        const maxSpend = R.ss16MaxSpend(sleeve, deployed, cash, cappedAlloc, openRisk, beast)
        if (maxSpend < MIN_SLICE) { rej('ss16_noCapital'); continue }
        const { shares, filled } = ss42Slice(maxSpend, q.price)
        if (shares <= 0 || filled > cash * (beast ? 0.99 : 0.92)) { rej('sliceTooSmall'); continue }
        const riskOnNew = (q.price - initStop) * shares
        if (openRisk + riskOnNew > sleeve * (beast ? R.BEAST_RISK_BUDGET_PCT : 0.03)) { rej('riskBudgetFull'); continue }
        const clusterNotional = clusterPos.reduce((s,p)=>s+p.value,0)
        if (!beast && clusterNotional + filled > R.CLUSTER_MAX_NOTIONAL_PCT * (deployed + filled)) { rej('clusterNotional'); continue }

        const band = beast ? R.ss58BandLine(q.price, atr) : undefined
        positions.push({ ticker: sym, shares, entryShares: shares, avgPrice: q.price, currentPrice: q.price, value: filled, pnl: 0, pnlPct: 0, sector, stopLevel: initStop, targetPrice: target, highWatermark: q.price, partialDone: false, entryTime: Date.now(), bars: b.slice(-20), isSafe: false, entrySignal: sigName, maxFavorable: 0, weakSince: 0, pivot: zPivot, pyramids: 0, isZanger: sigName.startsWith('SS52'), frozenStop: initStop, benchExtended: false, bandLine: band, sellLine: band, escalated: false, escUsed: false, escDeadline: 0, floorTouchedAt: 0 })
        cash -= filled; deployed += filled; openRisk += riskOnNew
        refs.fkStrike[sym] = (refs.fkStrike[sym] ?? 0) + 1
        if (refs.fkStrike[sym] >= R.SS59B_STRIKES && R.ss59DownOnly(b)) {
          refs.fkLock[sym] = Date.now() + R.SS59B_LOCK_MS
          notifications.push(`${sym} falling-knife lock, benched 2h`)
        }
        newTrades.push({ id: genId(), ticker: sym, action: 'BUY', shares, price: q.price, total: filled, reasoning: reason, timestamp: Date.now(), conviction: cappedAlloc >= 12 ? 'HIGH' : 'MEDIUM', signal: sigName, sleeve: 'MAIN' })
        execLog.push(`BUY ${sym} ${fmtShares(shares)}sh @ $${q.price.toFixed(2)} (${sigName})`)
        notifications.push(`${sym} ${fmtShares(shares)}sh @ $${q.price.toFixed(2)} — ${sigName}`)
      }
    }
  }

  /* ── Mark ── */
  const invested = positions.reduce((s,p) => s+p.value, 0)
  const newTotalValue = Math.max(0, cash) + invested
  const newTotalPnl = newTotalValue - cp.budget
  const newPnlPct = cp.budget > 0 ? (newTotalPnl / cp.budget) * 100 : 0

  /* ── SS66 daily log ── */
  const todayKey = etDayKey()
  let dailyLog = [...(cp.dailyLog ?? [])]
  let currentDay = cp.currentDay ?? 0
  let dayOpenValue = cp.dayOpenValue ?? cp.budget
  if (currentDay !== todayKey) {
    currentDay = todayKey
    dayOpenValue = (cp.totalValue && cp.totalValue > 0) ? cp.totalValue : cp.budget
    refs.dayPathMin = -1
  }
  const newDayPnl = newTotalValue - dayOpenValue
  const newDayPct = dayOpenValue > 0 ? (newDayPnl / dayOpenValue) * 100 : 0

  if (session !== 'closed' || dailyLog.some(d => d.day === todayKey)) {
    const allTrades = [...newTrades, ...(cp.trades ?? [])]
    const todayTrades = allTrades.filter(t => tsEtDayKey(t.timestamp) === todayKey)
    const todaySells = todayTrades.filter(t => t.action === 'SELL')
    const bySleeve = (sl: string) => todaySells.filter(t => (t.sleeve ?? 'MAIN') === sl).reduce((a,t) => a + (t.pnl ?? 0), 0)
    const idx = dailyLog.findIndex(d => d.day === todayKey)
    const prevRow = idx >= 0 ? dailyLog[idx] : null

    const fresh: Record<string, DayName> = {}
    for (const t of todayTrades) {
      const e = fresh[t.ticker] ?? { t: t.ticker, pnl: 0, fills: 0, sleeve: (t.sleeve ?? 'MAIN') }
      e.fills += 1
      if (t.action === 'SELL') e.pnl += (t.pnl ?? 0)
      if (t.sleeve) e.sleeve = t.sleeve
      fresh[t.ticker] = e
    }
    const stored: Record<string, DayName> = {}
    for (const n of (prevRow?.names ?? [])) stored[n.t] = n
    const merged: Record<string, DayName> = { ...stored }
    for (const [k, v] of Object.entries(fresh)) merged[k] = (stored[k] && stored[k].fills > v.fills) ? stored[k] : v
    const names = Object.values(merged).sort((a,b) => (b.pnl - a.pnl) || (b.fills - a.fills)).slice(0, 40)

    let path = prevRow?.path ?? []
    if (etMin !== refs.dayPathMin) { refs.dayPathMin = etMin; path = [...path, +newTotalValue.toFixed(2)].slice(-420) }

    const row: DaySummary = {
      day: todayKey, date: etDateISO(), label: etDateLabel(),
      openValue: dayOpenValue, closeValue: newTotalValue,
      high: Math.max(prevRow?.high ?? newTotalValue, newTotalValue),
      low:  Math.min(prevRow?.low  ?? newTotalValue, newTotalValue),
      pnl: newDayPnl, pnlPct: newDayPct,
      trades: todayTrades.length,
      wins: todaySells.filter(t => (t.pnl ?? 0) > 0).length,
      losses: todaySells.filter(t => (t.pnl ?? 0) <= 0).length,
      mainPnl: bySleeve('MAIN'), safePnl: bySleeve('SAFE'),
      regime: String(regime), mode: String(activeMode),
      names, path,
      closed: session !== 'regular' || etMin >= R.SS51_FLATTEN_MIN,
    }
    if (idx >= 0) dailyLog[idx] = row
    else dailyLog = [row, ...dailyLog].slice(0, 120)
  }

  /* ── SS57 self-reflection ── */
  if (etMin >= R.SS57_REVIEW_MIN && session !== 'regular' && lastReviewDay !== todayKey && (cp.trades ?? []).length > 0) {
    const today = (cp.trades ?? []).filter(t => tsEtDayKey(t.timestamp) === todayKey)
    const sells = today.filter(t => t.action === 'SELL')
    const w = sells.filter(t => (t.pnl ?? 0) > 0), l = sells.filter(t => (t.pnl ?? 0) <= 0)
    const dmg = l.reduce((s,t) => s + Math.abs(t.pnl ?? 0), 0)
    const gain = w.reduce((s,t) => s + (t.pnl ?? 0), 0)
    const bySig = (arr: Trade[]) => { const m: Record<string,number> = {}; arr.forEach(t => { const k = t.signal ?? 'UNKNOWN'; m[k] = (m[k] ?? 0) + 1 }); return m }
    const worst = Object.entries(bySig(l)).sort((a,b)=>b[1]-a[1])[0]
    const best  = Object.entries(bySig(w)).sort((a,b)=>b[1]-a[1])[0]
    const symDmg: Record<string,number> = {}
    l.forEach(t => { symDmg[t.ticker] = (symDmg[t.ticker] ?? 0) + Math.abs(t.pnl ?? 0) })
    const offenders = Object.entries(symDmg).sort((a,b)=>b[1]-a[1])

    const lines: string[] = []
    lines.push(`--- ${etDateISO()} - SELF-REFLECTION ---`)
    lines.push(`RESULT: day ${newDayPnl>=0?'+':''}$${newDayPnl.toFixed(2)} | ${today.length} fills | ${w.length}W/${l.length}L | regime ${regime} | mode ${activeMode}`)
    lines.push(`WHY I BOUGHT: ${Object.entries(bySig(today.filter(t=>t.action==='BUY'))).map(([k,v])=>`${k}x${v}`).join(', ') || 'no entries'}`)
    lines.push(`WHY I SOLD: ${Object.entries(bySig(sells)).map(([k,v])=>`${k}x${v}`).join(', ') || 'no exits'}`)
    if (l.length) lines.push(`WHAT WENT WRONG: ${l.length} losing exits cost $${dmg.toFixed(2)}${worst?`; worst pattern ${worst[0]} (${worst[1]}x)`:''}.`)
    if (w.length) lines.push(`WHAT WENT RIGHT: ${w.length} winning exits made $${gain.toFixed(2)}${best?`; best pattern ${best[0]} (${best[1]}x)`:''}.`)
    if (offenders.length) lines.push(`DAMAGE BY NAME: ${offenders.slice(0,3).map(([s,d])=>`${s} -$${d.toFixed(2)}`).join(', ')}`)
    if (refs.ss62Count > 0) lines.push(`SS62 GATE: blocked ${refs.ss62Count} signal(s) for thin volume. Blocked entries are the gate working.`)
    const handicapped: string[] = []
    offenders.forEach(([sym, d]) => {
      if (d >= Math.max(0.5, cp.budget * 0.004)) { refs.handicap[sym] = Date.now() + R.SS57_HANDICAP_SESSIONS * 86400000; handicapped.push(sym) }
    })
    if (handicapped.length) lines.push(`LANE 1 ACTION: handicapping ${handicapped.join(', ')} for ${R.SS57_HANDICAP_SESSIONS} sessions. Restrictive only, auto-expires.`)
    ledger = [lines.join('\n'), ...ledger].slice(0, R.SS57_LEDGER_MAX)
    lastReviewDay = todayKey
    refs.a2Strike = {}
    refs.ss62Count = 0
  }

  const cond = universeDefect ? 'UNIVERSE DEFECT — no trades'
    : inFlatten ? 'END-OF-DAY FLATTEN'
    : marketHalted ? 'HALT — BROAD SELLOFF'
    : scanOnly ? 'SCAN-ONLY (waits for 10:30)'
    : noTradeRoute ? 'NO TRADE — FULL RED (stand down)'
    : inBeastRoute ? `${activeMode === 'BEAST_PLUS' ? 'BEAST+' : 'BEAST'} — ${regime}`
    : (router && activeMode === 'ALGO_X') ? `ALGORITHM X — ${regime}`
    : noNewEntry ? 'NO NEW ENTRIES (EOD)'
    : defensiveMode ? 'DEFENSIVE — WEAK TAPE'
    : session === 'regular' ? 'DAY TRADING' : session.toUpperCase()

  const state: PortfolioState = {
    ...cp,
    cash: Math.max(0, cash), positions,
    trades: newTrades.length ? [...newTrades, ...cp.trades].slice(0, 200) : cp.trades,
    totalValue: newTotalValue, totalPnl: newTotalPnl, totalPnlPct: newPnlPct,
    dayPnl: newDayPnl, dayPnlPct: newDayPct,
    realizedPnl: realized, lastUpdated: Date.now(),
    winCount: cp.winCount + wins, lossCount: cp.lossCount + losses,
    scanCount: cp.scanCount + 1,
    valueHistory: [...cp.valueHistory, { t: Date.now(), v: newTotalValue }].slice(-300),
    regime, activeMode, roster, bench, switchBudget, lastRegimeEvalMin, beastLockedOut,
    universeDefect, lessonsLedger: ledger, lastReviewDay,
    dailyLog, currentDay, dayOpenValue,
    troyThesis: execLog.length ? `Executed: ${execLog.slice(0,3).join(' | ')}` : cp.troyThesis,
    nextAction: universeDefect ? 'SS54 defect — no entries until the feed is real.'
      : inFlatten ? 'Flattening for the close.'
      : noNewEntry ? 'EOD cutoff — managing exits.'
      : marketHalted ? 'Halt — no new longs.'
      : `5s scan — up to ${maxConcurrent} names`,
    marketCondition: cond,
  }

  return {
    state, refs, newTrades, execLog, notifications, rejects,
    gate: {
      maxConcurrent, held: positions.filter(p => !p.isSafe).length,
      scanOnly, noTrade: noTradeRoute, cautiousRed,
      window: intraWindow, spy: +spyChange.toFixed(2), breadth: +(greenFrac * 100).toFixed(0),
      relax,
    },
  }
}
