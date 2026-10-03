/* ═══════════════════════════════════════════════════════════════════════════
   SWING CORE - the strategy that passed all three stress tests.

     Combo: 20-day breakout + RSI2 dips, one shared book.

   This file is the single source of truth. The live engine (run.ts) and the
   historical replay (quant/swing-parity.ts) both call decide() and execute()
   from here, so the code trading on Railway is provably the code that was
   tested. Change a rule here and rerun the parity test before deploying.

   The rules
     Uptrend          close > 200-day simple moving average
     BREAKOUT leg     uptrend AND close > highest high of the prior 20 days
                      ranked by 20-day return, up to 10 positions
                      exit: close < lowest low of the prior 10 days, or 60 days
     DIP leg          uptrend AND RSI(2) < 5
                      ranked by lowest RSI(2), up to 5 positions, idle cash only
                      exit: close > 5-day simple moving average, or 10 days
     Sizing           every position is 1/10 of the book. Breakout gets cash
                      first; dips only use what is left.
     Timing           signals on the daily close, orders at the next open.
     Costs            5bp per side on every fill.
   ═══════════════════════════════════════════════════════════════════════════ */

export const COST = 0.0005
export const BASE_SLOTS = 10
export type Leg = 'BREAKOUT' | 'DIP' | 'DIP75'
export type ProfileId = 'COMBO' | 'HIGHWIN'
export interface Profile { id: ProfileId; title: string; legs: { leg: Leg; slots: number; maxHold: number }[] }

/* Two books, two goals.
   COMBO   the money-maker: breakout + dips. ~52% wins, ~27%/yr in the backtest.
   HIGHWIN the win-rate book: dips only, sold on the first close above entry.
           ~76% wins, ~9.6%/yr in the backtest. */
export const PROFILES: Record<ProfileId, Profile> = {
  COMBO: { id: 'COMBO', title: 'Swing book: breakout + dips', legs: [{ leg: 'BREAKOUT', slots: 10, maxHold: 60 }, { leg: 'DIP', slots: 5, maxHold: 10 }] },
  HIGHWIN: { id: 'HIGHWIN', title: 'High win-rate book: dips, quick profit', legs: [{ leg: 'DIP75', slots: 10, maxHold: 10 }] },
}
export const DIP_RSI2 = 5

/* ── series + indicators ──
   Indicators run on dividend-adjusted prices (so a dividend is not a fake
   drop). Fills and marks use the traded price (fo/fc). In the replay both are
   the same adjusted series, exactly as in the research. */
export interface DSeries {
  days: number[]; idx: Map<number, number>
  o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array
  fo: Float64Array; fc: Float64Array
  sma5: Float64Array; sma200: Float64Array; rsi2: Float64Array
  hh20: Float64Array; ll10: Float64Array; ret20: Float64Array
}
/** bars: [day, adjO, adjH, adjL, adjC, fillOpen, fillClose] in day order */
export function buildSeries(bars: [number, number, number, number, number, number, number][]): DSeries {
  const n = bars.length
  const f = () => new Float64Array(n).fill(NaN)
  const s: DSeries = { days: bars.map(b => b[0]), idx: new Map(bars.map((b, i) => [b[0], i])), o: f(), h: f(), l: f(), c: f(), fo: f(), fc: f(), sma5: f(), sma200: f(), rsi2: f(), hh20: f(), ll10: f(), ret20: f() }
  bars.forEach((b, i) => { s.o[i] = b[1]; s.h[i] = b[2]; s.l[i] = b[3]; s.c[i] = b[4]; s.fo[i] = b[5]; s.fc[i] = b[6] })
  let s5 = 0, s200 = 0
  for (let i = 0; i < n; i++) {
    s5 += s.c[i]; s200 += s.c[i]
    if (i >= 5) s5 -= s.c[i - 5]
    if (i >= 200) s200 -= s.c[i - 200]
    if (i >= 4) s.sma5[i] = s5 / 5
    if (i >= 199) s.sma200[i] = s200 / 200
  }
  // Wilder RSI(2): avg = (prev * (n-1) + x) / n with n = 2
  let ag = NaN, al = NaN
  for (let i = 1; i < n; i++) {
    const d = s.c[i] - s.c[i - 1]
    const g = Math.max(0, d), ls = Math.max(0, -d)
    if (!Number.isFinite(ag)) { ag = g; al = ls } else { ag = (ag + g) / 2; al = (al + ls) / 2 }
    s.rsi2[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  }
  for (let i = 0; i < n; i++) {
    if (i >= 20) { let m = -Infinity; for (let k = i - 20; k < i; k++) m = Math.max(m, s.h[k]); s.hh20[i] = m; s.ret20[i] = s.c[i] / s.c[i - 20] - 1 }
    if (i >= 10) { let m = Infinity; for (let k = i - 10; k < i; k++) m = Math.min(m, s.l[k]); s.ll10[i] = m }
  }
  return s
}

const ok = (x: number) => Number.isFinite(x)
const uptrend = (s: DSeries, i: number) => s.c[i] > s.sma200[i]
export function entryScore(leg: Leg, s: DSeries, i: number): number | null {
  if (!ok(s.c[i]) || !ok(s.sma200[i]) || !ok(s.rsi2[i])) return null
  if (leg === 'BREAKOUT') return uptrend(s, i) && ok(s.hh20[i]) && s.c[i] > s.hh20[i] ? s.ret20[i] : null
  return uptrend(s, i) && s.rsi2[i] < DIP_RSI2 ? -s.rsi2[i] : null   // DIP and DIP75 enter the same way
}
export function exitReason(leg: Leg, s: DSeries, i: number, entryPx: number): string | null {
  if (leg === 'BREAKOUT') return ok(s.ll10[i]) && s.c[i] < s.ll10[i] ? `closed below 10-day low $${s.ll10[i].toFixed(2)}` : null
  if (leg === 'DIP75') return ok(s.fc[i]) && s.fc[i] > entryPx * (1 + 2 * COST) ? `closed above entry ($${s.fc[i].toFixed(2)} vs $${entryPx.toFixed(2)}), take the win` : null
  return ok(s.sma5[i]) && s.c[i] > s.sma5[i] ? `closed above 5-day average $${s.sma5[i].toFixed(2)}` : null
}

/* ── book ── */
export interface SwingPos { sym: string; leg: Leg; entryDay: number; entryPx: number; shares: number; splits?: number[]; lastPx?: number }
export interface Pending { decidedOn: number; slotSize: number; exits: { sym: string; reason: string }[]; entries: { sym: string; leg: Leg; why: string }[] }
export interface SwingTrade { id: string; sym: string; leg: Leg; action: 'BUY' | 'SELL'; day: number; price: number; shares: number; total: number; pnl?: number; ret?: number; net?: number; holdDays?: number; reason: string }
export interface SwingBook {
  version: 1; profile: ProfileId; budget: number; cash: number; positions: SwingPos[]
  pending: Pending | null; lastDecisionDay: number; lastExecDay: number
  startedDay: number; equity: number; equityHistory: { day: number; v: number }[]
  realized: number
}
export function newBook(budget: number, day: number, profile: ProfileId = 'COMBO'): SwingBook {
  return { version: 1, profile, budget, cash: budget, positions: [], pending: null, lastDecisionDay: 0, lastExecDay: 0, startedDay: day, equity: budget, equityHistory: [], realized: 0 }
}

function lastFill(s: DSeries | undefined, day: number, field: 'fc' | 'fo'): number {
  if (!s) return NaN
  let i = s.idx.get(day)
  if (i !== undefined && ok(s[field][i])) return s[field][i]
  // most recent close at or before day
  for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= day && ok(s.fc[k])) return s.fc[k]
  return NaN
}
export function markEquity(book: SwingBook, S: Record<string, DSeries>, day: number): number {
  let inv = 0
  for (const p of book.positions) { const px = lastFill(S[p.sym], day, 'fc'); if (ok(px)) p.lastPx = px; inv += p.shares * (ok(px) ? px : p.entryPx) }
  return book.cash + inv
}

/** At the close of `day`: decide tomorrow's exits and entries. Mutates book.pending. */
export function decide(book: SwingBook, S: Record<string, DSeries>, universe: string[], day: number): Pending {
  const LEGS = PROFILES[book.profile ?? 'COMBO'].legs
  const equity = markEquity(book, S, day)
  book.equity = equity
  const slotSize = equity / BASE_SLOTS
  const exits: Pending['exits'] = []
  for (const p of book.positions) {
    const s = S[p.sym]; const i = s?.idx.get(day); if (!s || i === undefined) continue
    const e = s.idx.get(p.entryDay); const held = e === undefined ? 0 : i - e + 1
    const leg = LEGS.find(x => x.leg === p.leg)!
    const why = held >= leg.maxHold ? `time limit (${held} days)` : exitReason(p.leg, s, i, p.entryPx)
    if (why) exits.push({ sym: p.sym, reason: why })
  }
  const exiting = new Set(exits.map(x => x.sym))
  let freeCash = book.cash + book.positions.filter(p => exiting.has(p.sym)).reduce((a, p) => a + p.shares * lastFill(S[p.sym], day, 'fc'), 0)
  const held = new Set(book.positions.filter(p => !exiting.has(p.sym)).map(p => p.sym))
  const entries: Pending['entries'] = []
  for (const leg of LEGS) {
    const mine = book.positions.filter(p => p.leg === leg.leg && !exiting.has(p.sym)).length
    const free = Math.min(leg.slots - mine, Math.floor(freeCash / slotSize + 1e-9))
    if (free <= 0) continue
    const cands: [string, number, string][] = []
    for (const u of universe) {
      if (held.has(u) || exiting.has(u)) continue
      const s = S[u]; const i = s?.idx.get(day); if (!s || i === undefined) continue
      const sc = entryScore(leg.leg, s, i)
      if (sc !== null && ok(sc)) cands.push([u, sc, leg.leg === 'BREAKOUT' ? `new 20-day high $${s.c[i].toFixed(2)} in an uptrend, 20-day return ${(s.ret20[i] * 100).toFixed(1)}%` : `RSI(2) ${s.rsi2[i].toFixed(1)}, a sharp dip in an uptrend`])
    }
    for (const [u, , why] of cands.sort((a, b) => b[1] - a[1]).slice(0, free)) { entries.push({ sym: u, leg: leg.leg, why }); held.add(u); freeCash -= slotSize }
  }
  book.pending = { decidedOn: day, slotSize, exits, entries }
  book.lastDecisionDay = day
  return book.pending
}

/** At the open of `day`: fill yesterday's pending orders at today's open. */
export function execute(book: SwingBook, S: Record<string, DSeries>, day: number, idGen: () => string): SwingTrade[] {
  const LEGS = PROFILES[book.profile ?? 'COMBO'].legs
  const out: SwingTrade[] = []
  const pend = book.pending; if (!pend || pend.decidedOn >= day) return out
  for (const x of pend.exits) {
    const p = book.positions.find(q => q.sym === x.sym); if (!p) continue
    const s = S[p.sym]
    const o = s?.idx.get(day) !== undefined ? s!.fo[s!.idx.get(day)!] : NaN
    const fill = ok(o) ? o : lastFill(s, day, 'fc')
    const proceeds = p.shares * fill * (1 - COST)
    const basis = p.shares * p.entryPx * (1 + COST)
    book.cash += proceeds
    book.positions = book.positions.filter(q => q !== p)
    const e = s?.idx.get(p.entryDay), i = s?.idx.get(day)
    const pnl = proceeds - basis
    book.realized += pnl
    out.push({ id: idGen(), sym: p.sym, leg: p.leg, action: 'SELL', day, price: fill, shares: p.shares, total: proceeds, pnl, ret: fill / p.entryPx - 1, net: proceeds / basis - 1, holdDays: e !== undefined && i !== undefined ? i - e : 0, reason: x.reason })
  }
  for (const x of pend.entries) {
    const leg = LEGS.find(l => l.leg === x.leg)!
    if (book.positions.filter(p => p.leg === x.leg).length >= leg.slots) continue
    const s = S[x.sym]; const i = s?.idx.get(day); if (!s || i === undefined) continue
    const px = s.fo[i]; if (!ok(px)) continue
    const alloc = Math.min(book.cash, pend.slotSize); if (alloc < pend.slotSize * 0.5) break
    const shares = alloc / (px * (1 + COST))
    book.positions.push({ sym: x.sym, leg: x.leg, entryDay: day, entryPx: px, shares })
    book.cash -= alloc
    out.push({ id: idGen(), sym: x.sym, leg: x.leg, action: 'BUY', day, price: px, shares, total: alloc, reason: x.why })
  }
  book.pending = null
  book.lastExecDay = day
  return out
}
