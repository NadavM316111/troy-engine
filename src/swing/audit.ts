/* ═══════════════════════════════════════════════════════════════════════════
   AUDIT - is the live book doing exactly what the tested code says it should?

   Rebuilds each user's book from scratch with the tested core (swing/core.ts):
   the COMBO book from its first day, the switch to TROY, the reset to a round
   starting value, every decision and every fill. Then compares, trade by
   trade, with what was actually recorded in swing_trades, plus tonight's
   orders and the book's value.

   Runs after every 16:20 decision and once on startup. The result is logged
   and shown in the daily email. A mismatch means a bug, not bad luck.
   ═══════════════════════════════════════════════════════════════════════════ */
import { activeUsers, log } from '../db.js'
import { decide, execute, newBook, PROFILES, type DSeries, type SwingBook, type SwingTrade } from './core.js'
import { loadBook, saveBook, swingTrades } from './db.js'
import { SWING_UNIVERSE, loadUniverse } from './run.js'

export interface AuditResult {
  day: number; total: number; matched: number
  missing: string[]; extra: string[]
  worstPriceDiffPct: number; worstSizeDiffPct: number
  ordersMatch: boolean; ordersNote: string
  priceDiffs: string[]
  equityLive: number; equityReplay: number; equityDiffPct: number
  ok: boolean
  /** trades and tonight's orders match the tested code; only fill prices / book value may differ */
  logicOk: boolean
}

const key = (t: { day: number; action: string; sym?: string; ticker?: string }) => `${t.day}|${t.action}|${t.sym ?? t.ticker}`

export async function auditUser(userId: string, S: Record<string, DSeries>): Promise<AuditResult | null> {
  const troy = await loadBook(userId, 'TROY'); if (!troy) return null
  const combo = await loadBook(userId, 'COMBO')
  const live = [...(await swingTrades(userId, 'COMBO')), ...(await swingTrades(userId, 'TROY'))]
  return auditFromData(troy, combo, live, S)
}

/** Pure part: no database, so it can be tested offline. */
export function auditFromData(troy: SwingBook, combo: SwingBook | null, live: any[], S: Record<string, DSeries>): AuditResult | null {
  const spy = S['SPY']; if (!spy) return null
  const firstDay = combo?.startedDay ?? troy.startedDay
  const switchDay = combo?.lastExecDay ?? 0
  const lastDay = troy.lastDecisionDay
  const days = spy.days.filter(d => d >= firstDay && d <= lastDay)
  const btcFill = new Map<number, number>(); for (const t of live) if (t.ticker === 'BTC-USD') btcFill.set(Number(t.day), Number(t.price))

  let book: SwingBook = newBook(combo?.budget ?? troy.budget, firstDay, combo ? 'COMBO' : 'TROY')
  const liveTom = PROFILES.TROY.tomStops
  const liveLev = PROFILES.TROY.leverage, liveEarn = PROFILES.TROY.earnDrift
  const resets = troy.resets?.length ? troy.resets : [{ day: troy.startedDay, budget: troy.budget }]
  // settings in force on a day: the last change on or before it; before any recorded change, the original 1.8x with no earnings drift
  const settingsOn = (d: number) => { const s = (troy.settings ?? []).filter(x => x.day <= d).at(-1); return s ?? { leverage: 1.8, earn: 0 } }
  const expected: SwingTrade[] = []; let n = 0; const id = () => `a${++n}`
  try {
  for (const d of days) {
    PROFILES.TROY.tomStops = troy.tomStopsSince && d >= troy.tomStopsSince ? liveTom : undefined
    { const st = settingsOn(d); PROFILES.TROY.leverage = st.leverage; PROFILES.TROY.earnDrift = st.earn > 0 ? { ...(liveEarn ?? { jump: 0.03, hold: 20, slots: 10 }), weight: st.earn } : undefined }
    if (d > firstDay) expected.push(...execute(book, S, d, id, { btcFillPx: btcFill.get(d) }))
    if (combo && d === switchDay) book = { ...book, profile: 'TROY', btc: null, interest: 0, pending: null, lastDecisionDay: 0 }
    const p = decide(book, S, SWING_UNIVERSE, d, {}, id)
    expected.push(...(p.closeFills ?? []))
    // scoreboard resets ("since start" set to a round number on that day, a paper top-up or trim of cash), replayed in order
    const rs = resets.find(r => r.day === d)
    if (rs && book.profile === 'TROY') { book.cash += rs.budget - book.equity; book.equity = rs.budget; book.budget = rs.budget; book.realized = 0; book.interest = 0 }
  }
  } finally { PROFILES.TROY.tomStops = liveTom; PROFILES.TROY.leverage = liveLev; PROFILES.TROY.earnDrift = liveEarn }

  const actual = live.filter(t => Number(t.day) > firstDay && Number(t.day) <= lastDay)
  const aKeys = new Map(actual.map(t => [key({ day: Number(t.day), action: t.action, ticker: t.ticker }), t]))
  const eKeys = new Map(expected.map(t => [key(t), t]))
  let matched = 0, worstPx = 0, worstSz = 0
  const missing: string[] = [], extra: string[] = [], priceDiffs: string[] = []
  for (const [k, e] of eKeys) {
    const a = aKeys.get(k)
    if (!a) { missing.push(k); continue }
    matched++
    if (e.sym !== 'BTC-USD') {
      const dp = (Number(a.price) / e.price - 1) * 100
      worstPx = Math.max(worstPx, Math.abs(dp))
      if (Math.abs(dp) >= 0.5) priceDiffs.push(`${e.action} ${e.sym} on ${new Date(e.day * 86400000).toISOString().slice(0, 10)}: live $${Number(a.price).toFixed(2)} vs official open $${e.price.toFixed(2)} (${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%, ${(e.action === 'BUY' ? dp > 0 : dp < 0) ? 'live got the WORSE price' : 'live got the better price'})`)
    }
    worstSz = Math.max(worstSz, Math.abs(Number(a.total) / e.total - 1) * 100)
  }
  for (const k of aKeys.keys()) if (!eKeys.has(k)) extra.push(k)

  const lp = troy.pending, rp = book.pending
  const names = (p: typeof lp) => p ? [...p.exits.map(x => `SELL ${x.sym}`), ...(p.partials ?? []).map(x => `BANK ${x.sym}`), ...p.entries.map(x => `BUY ${x.sym}`), ...(p.btc ? [`BTC ${p.btc.targetValue > 0 ? 'SET' : 'OUT'}`] : [])].sort().join(', ') : ''
  const ordersMatch = names(lp) === names(rp)
  const eqDiff = Math.abs(book.equity / troy.equity - 1) * 100
  const logicOk = missing.length === 0 && extra.length === 0 && ordersMatch && eqDiff < 3
  const ok = logicOk && worstPx < 0.5 && worstSz < 2 && eqDiff < 1.5
  return {
    day: lastDay, total: Math.max(eKeys.size, aKeys.size), matched, missing, extra,
    worstPriceDiffPct: +worstPx.toFixed(3), worstSizeDiffPct: +worstSz.toFixed(3),
    priceDiffs, ordersMatch, ordersNote: ordersMatch ? names(lp) || 'none' : `live: ${names(lp) || 'none'} | tested: ${names(rp) || 'none'}`,
    equityLive: troy.equity, equityReplay: book.equity, equityDiffPct: +eqDiff.toFixed(3), ok, logicOk,
  }
}

/** Audit every active user, store the result on the TROY book, log it. */
export async function auditAll(S?: Record<string, DSeries>) {
  try {
    const data = S ?? (await loadUniverse('2y')).S
    if (!S && PROFILES.TROY.earnDrift && data['SPY']) {
      const { refreshEarnings } = await import('./run.js')
      const books = await Promise.all((await activeUsers()).map(u => loadBook(u.user_id, 'COMBO').then(c => c?.startedDay ?? Infinity)))
      const days = data['SPY'].days
      await refreshEarnings(books.filter(Number.isFinite), days, days[days.length - 1])
    }
    for (const u of await activeUsers()) {
      const r = await auditUser(u.user_id, data); if (!r) continue
      const book = await loadBook(u.user_id, 'TROY'); if (!book) continue
      ;(book as any).audit = r
      await saveBook(u.user_id, book)
      const head = r.ok ? 'AUDIT PASS' : r.logicOk ? 'AUDIT PASS (fill-price gaps only)' : 'AUDIT MISMATCH'
      await log(r.logicOk ? 'info' : 'warn', `[${u.email}] ${head}: ${r.matched}/${r.total} trades match, worst price diff ${r.worstPriceDiffPct}%, worst size diff ${r.worstSizeDiffPct}%, orders ${r.ordersMatch ? 'match' : 'DIFFER'}, value live $${r.equityLive.toFixed(0)} vs tested $${r.equityReplay.toFixed(0)} (${r.equityDiffPct}%)${r.missing.length ? ` | missing: ${r.missing.join(' ')}` : ''}${r.extra.length ? ` | extra: ${r.extra.join(' ')}` : ''}${r.ordersMatch ? '' : ` | ${r.ordersNote}`}${r.priceDiffs.length ? ` | price gaps: ${r.priceDiffs.join('; ')}` : ''}`, undefined, u.user_id)
    }
  } catch (e: any) {
    await log('error', 'audit failed', { err: String(e?.stack ?? e) })
  }
}
