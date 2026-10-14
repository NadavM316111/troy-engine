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
import { decide, execute, newBook, type DSeries, type SwingBook, type SwingTrade } from './core.js'
import { loadBook, saveBook, swingTrades } from './db.js'
import { SWING_UNIVERSE, loadUniverse } from './run.js'

export interface AuditResult {
  day: number; total: number; matched: number
  missing: string[]; extra: string[]
  worstPriceDiffPct: number; worstSizeDiffPct: number
  ordersMatch: boolean; ordersNote: string
  equityLive: number; equityReplay: number; equityDiffPct: number
  ok: boolean
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
  const expected: SwingTrade[] = []; let n = 0; const id = () => `a${++n}`
  for (const d of days) {
    if (d > firstDay) expected.push(...execute(book, S, d, id, { btcFillPx: btcFill.get(d) }))
    if (combo && d === switchDay) book = { ...book, profile: 'TROY', btc: null, interest: 0, pending: null, lastDecisionDay: 0 }
    const p = decide(book, S, SWING_UNIVERSE, d, {}, id)
    expected.push(...(p.closeFills ?? []))
    if (d === troy.startedDay && book.profile === 'TROY' && Math.abs(book.equity - troy.budget) > 1e-6 * troy.budget) {
      // the scoreboard reset on the TROY start day (round starting value, paper top-up)
      book.cash += troy.budget - book.equity; book.equity = troy.budget; book.budget = troy.budget; book.realized = 0; book.interest = 0
    }
  }

  const actual = live.filter(t => Number(t.day) > firstDay && Number(t.day) <= lastDay)
  const aKeys = new Map(actual.map(t => [key({ day: Number(t.day), action: t.action, ticker: t.ticker }), t]))
  const eKeys = new Map(expected.map(t => [key(t), t]))
  let matched = 0, worstPx = 0, worstSz = 0
  const missing: string[] = [], extra: string[] = []
  for (const [k, e] of eKeys) {
    const a = aKeys.get(k)
    if (!a) { missing.push(k); continue }
    matched++
    if (e.sym !== 'BTC-USD') worstPx = Math.max(worstPx, Math.abs(Number(a.price) / e.price - 1) * 100)
    worstSz = Math.max(worstSz, Math.abs(Number(a.total) / e.total - 1) * 100)
  }
  for (const k of aKeys.keys()) if (!eKeys.has(k)) extra.push(k)

  const lp = troy.pending, rp = book.pending
  const names = (p: typeof lp) => p ? [...p.exits.map(x => `SELL ${x.sym}`), ...p.entries.map(x => `BUY ${x.sym}`), ...(p.btc ? [`BTC ${p.btc.targetValue > 0 ? 'SET' : 'OUT'}`] : [])].sort().join(', ') : ''
  const ordersMatch = names(lp) === names(rp)
  const eqDiff = Math.abs(book.equity / troy.equity - 1) * 100
  const ok = missing.length === 0 && extra.length === 0 && ordersMatch && worstPx < 0.5 && worstSz < 2 && eqDiff < 1.5
  return {
    day: lastDay, total: Math.max(eKeys.size, aKeys.size), matched, missing, extra,
    worstPriceDiffPct: +worstPx.toFixed(3), worstSizeDiffPct: +worstSz.toFixed(3),
    ordersMatch, ordersNote: ordersMatch ? names(lp) || 'none' : `live: ${names(lp) || 'none'} | tested: ${names(rp) || 'none'}`,
    equityLive: troy.equity, equityReplay: book.equity, equityDiffPct: +eqDiff.toFixed(3), ok,
  }
}

/** Audit every active user, store the result on the TROY book, log it. */
export async function auditAll(S?: Record<string, DSeries>) {
  try {
    const data = S ?? (await loadUniverse('2y')).S
    for (const u of await activeUsers()) {
      const r = await auditUser(u.user_id, data); if (!r) continue
      const book = await loadBook(u.user_id, 'TROY'); if (!book) continue
      ;(book as any).audit = r
      await saveBook(u.user_id, book)
      const head = r.ok ? 'AUDIT PASS' : 'AUDIT MISMATCH'
      await log(r.ok ? 'info' : 'warn', `[${u.email}] ${head}: ${r.matched}/${r.total} trades match, worst price diff ${r.worstPriceDiffPct}%, worst size diff ${r.worstSizeDiffPct}%, orders ${r.ordersMatch ? 'match' : 'DIFFER'}, value live $${r.equityLive.toFixed(0)} vs tested $${r.equityReplay.toFixed(0)} (${r.equityDiffPct}%)${r.missing.length ? ` | missing: ${r.missing.join(' ')}` : ''}${r.extra.length ? ` | extra: ${r.extra.join(' ')}` : ''}${r.ordersMatch ? '' : ` | ${r.ordersNote}`}`, undefined, u.user_id)
    }
  } catch (e: any) {
    await log('error', 'audit failed', { err: String(e?.stack ?? e) })
  }
}
