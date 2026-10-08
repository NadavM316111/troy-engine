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
export type Leg = 'BREAKOUT' | 'DIP' | 'DIP75' | 'BTC'
export type ProfileId = 'COMBO' | 'HIGHWIN' | 'TROY'
export interface Profile {
  id: ProfileId; title: string; legs: { leg: Leg; slots: number; maxHold: number }[]
  leverage?: number      // gross exposure as a multiple of equity (1 = no borrowing)
  btcWeight?: number     // share of exposure in the Bitcoin trend sleeve
  btcSym?: string
  cashRate?: number      // yearly interest earned on idle cash
  borrowRate?: number    // yearly interest paid on borrowed money
  btcCost?: number       // cost per side on Bitcoin trades
  exitAtClose?: boolean  // sell exits at the signal-day close instead of the next open
}

/* Books.
   TROY    the one live book: 70% combo + 30% Bitcoin trend at 1.8x. Picked from
           ~6,000 tested setups as the best ~0.20%/day with the smallest drop.
   COMBO / HIGHWIN  the earlier books, kept so their history and parity stay valid. */
export const PROFILES: Record<ProfileId, Profile> = {
  COMBO: { id: 'COMBO', title: 'Swing book: breakout + dips', legs: [{ leg: 'BREAKOUT', slots: 10, maxHold: 60 }, { leg: 'DIP', slots: 5, maxHold: 10 }] },
  HIGHWIN: { id: 'HIGHWIN', title: 'High win-rate book: dips, quick profit', legs: [{ leg: 'DIP75', slots: 10, maxHold: 10 }] },
  TROY: {
    id: 'TROY', title: 'TROY: stock combo + Bitcoin trend, 1.8x',
    legs: [{ leg: 'BREAKOUT', slots: 10, maxHold: 60 }, { leg: 'DIP', slots: 5, maxHold: 10 }],
    leverage: Number(process.env.TROY_LEVERAGE ?? 1.8), btcWeight: 0.3, btcSym: 'BTC-USD',
    cashRate: 0.04, borrowRate: 0.05, btcCost: 0.0015,
    exitAtClose: process.env.TROY_EXIT_AT_CLOSE === 'on',
  },
}
export const DIP_RSI2 = 5
export const BTC_TREND_DAYS = 100
export const BTC_BAND = 0.15   // only rebalance Bitcoin when it drifts 15%+ from its target

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
export interface BtcHolding { units: number; avgPx: number; sinceDay: number; lastPx?: number }
export interface Pending {
  decidedOn: number; slotSize: number; stockCap?: number
  exits: { sym: string; reason: string }[]
  entries: { sym: string; leg: Leg; why: string }[]
  btc?: { targetValue: number; why: string } | null
  trimTo?: number | null
  closeFills?: SwingTrade[]
}
export interface SwingTrade { id: string; sym: string; leg: Leg; action: 'BUY' | 'SELL'; day: number; price: number; shares: number; total: number; pnl?: number; ret?: number; net?: number; holdDays?: number; reason: string }
export interface SwingBook {
  version: 1; profile: ProfileId; budget: number; cash: number; positions: SwingPos[]
  pending: Pending | null; lastDecisionDay: number; lastExecDay: number
  startedDay: number; equity: number; equityHistory: { day: number; v: number }[]
  realized: number
  btc?: BtcHolding | null
  interest?: number
  lastEmailDay?: number
}
export function newBook(budget: number, day: number, profile: ProfileId = 'COMBO'): SwingBook {
  return { version: 1, profile, budget, cash: budget, positions: [], pending: null, lastDecisionDay: 0, lastExecDay: 0, startedDay: day, equity: budget, equityHistory: [], realized: 0, btc: null, interest: 0 }
}

function lastFill(s: DSeries | undefined, day: number, field: 'fc' | 'fo'): number {
  if (!s) return NaN
  const i = s.idx.get(day)
  if (i !== undefined && ok(s[field][i])) return s[field][i]
  for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= day && ok(s.fc[k])) return s.fc[k]
  return NaN
}
function lastIdx(s: DSeries, day: number): number { for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= day) return k; return -1 }

/* Options for the Bitcoin sleeve's timing.
   Live: decide on the price at 16:20 ET (today's partial bar) and fill at the
   live price at 09:35 the next morning. Replay: decide on yesterday's UTC close
   (already known at 16:20 ET) and fill at the next UTC open. Neither looks ahead. */
export interface CoreOpts { btcDay?: number; btcFillPx?: number }

export function stockValue(book: SwingBook, S: Record<string, DSeries>, day: number): number {
  let inv = 0
  for (const p of book.positions) { const px = lastFill(S[p.sym], day, 'fc'); if (ok(px)) p.lastPx = px; inv += p.shares * (ok(px) ? px : p.entryPx) }
  return inv
}
export function btcPrice(book: SwingBook, S: Record<string, DSeries>, day: number): number {
  const sym = PROFILES[book.profile ?? 'COMBO'].btcSym; if (!sym) return NaN
  return lastFill(S[sym], day, 'fc')
}
export function markEquity(book: SwingBook, S: Record<string, DSeries>, day: number, opts: CoreOpts = {}): number {
  let v = book.cash + stockValue(book, S, day)
  if (book.btc && book.btc.units > 0) { const px = btcPrice(book, S, opts.btcDay ?? day); if (ok(px)) book.btc.lastPx = px; v += book.btc.units * (ok(px) ? px : book.btc.avgPx) }
  return v
}

function sellStock(book: SwingBook, p: SwingPos, fill: number, day: number, S: Record<string, DSeries>, reason: string, id: string, frac = 1): SwingTrade {
  const sh = p.shares * frac
  const proceeds = sh * fill * (1 - COST)
  const basis = sh * p.entryPx * (1 + COST)
  book.cash += proceeds
  if (frac >= 1 - 1e-12) book.positions = book.positions.filter(q => q !== p); else p.shares -= sh
  const s = S[p.sym]; const e = s?.idx.get(p.entryDay), i = s?.idx.get(day)
  const pnl = proceeds - basis
  book.realized += pnl
  return { id, sym: p.sym, leg: p.leg, action: 'SELL', day, price: fill, shares: sh, total: proceeds, pnl, ret: fill / p.entryPx - 1, net: proceeds / basis - 1, holdDays: e !== undefined && i !== undefined ? i - e : 0, reason }
}

/** At the close of `day`: decide tomorrow's orders. Mutates book.pending. */
export function decide(book: SwingBook, S: Record<string, DSeries>, universe: string[], day: number, opts: CoreOpts = {}, idGen: () => string = () => `${day}-${Math.random().toString(36).slice(2)}`): Pending {
  const prof = PROFILES[book.profile ?? 'COMBO']
  const LEGS = prof.legs
  const L = prof.leverage ?? 1, w = prof.btcWeight ?? 0
  // a day's interest on cash: earned when positive, paid when borrowing
  if (prof.cashRate !== undefined && book.lastDecisionDay > 0 && day > book.lastDecisionDay) {
    const r = book.cash >= 0 ? (prof.cashRate ?? 0) : (prof.borrowRate ?? 0)
    const x = book.cash * r / 252
    book.cash += x; book.interest = (book.interest ?? 0) + x
  }
  const equity = markEquity(book, S, day, opts)
  book.equity = equity
  const stockCap = L * (1 - w) * equity
  const slotSize = stockCap / BASE_SLOTS
  const exits: Pending['exits'] = []
  for (const p of book.positions) {
    const s = S[p.sym]; const i = s?.idx.get(day); if (!s || i === undefined) continue
    const e = s.idx.get(p.entryDay); const held = e === undefined ? 0 : i - e + 1
    const leg = LEGS.find(x => x.leg === p.leg) ?? LEGS[0]
    const why = held >= leg.maxHold ? `time limit (${held} days)` : exitReason(p.leg, s, i, p.entryPx)
    if (why) exits.push({ sym: p.sym, reason: why })
  }
  // optional: sell exits at today's close instead of tomorrow's open
  const closeFills: SwingTrade[] = []
  if (prof.exitAtClose) {
    for (const x of exits) { const p = book.positions.find(q => q.sym === x.sym); if (!p) continue; const f = lastFill(S[p.sym], day, 'fc'); if (ok(f)) closeFills.push(sellStock(book, p, f, day, S, `${x.reason} (sold at the close)`, idGen())) }
    exits.length = 0
  }
  const exiting = new Set(exits.map(x => x.sym))
  const keepVal = book.positions.filter(p => !exiting.has(p.sym)).reduce((a, p) => a + p.shares * lastFill(S[p.sym], day, 'fc'), 0)
  let room = stockCap - keepVal
  const held = new Set(book.positions.filter(p => !exiting.has(p.sym)).map(p => p.sym))
  const entries: Pending['entries'] = []
  for (const leg of LEGS) {
    const mine = book.positions.filter(p => p.leg === leg.leg && !exiting.has(p.sym)).length
    const free = Math.min(leg.slots - mine, Math.floor(room / slotSize + 1e-9))
    if (free <= 0) continue
    const cands: [string, number, string][] = []
    for (const u of universe) {
      if (held.has(u) || exiting.has(u)) continue
      const s = S[u]; const i = s?.idx.get(day); if (!s || i === undefined) continue
      const sc = entryScore(leg.leg, s, i)
      if (sc !== null && ok(sc)) cands.push([u, sc, leg.leg === 'BREAKOUT' ? `new 20-day high $${s.c[i].toFixed(2)} in an uptrend, 20-day return ${(s.ret20[i] * 100).toFixed(1)}%` : `RSI(2) ${s.rsi2[i].toFixed(1)}, a sharp dip in an uptrend`])
    }
    for (const [u, , why] of cands.sort((a, b) => b[1] - a[1]).slice(0, free)) { entries.push({ sym: u, leg: leg.leg, why }); held.add(u); room -= slotSize }
  }
  // stock exposure drifted far above its cap (after a fall in equity): trim back
  const trimTo = L > 1 && keepVal > stockCap * 1.15 ? stockCap : null
  // Bitcoin sleeve: hold it while above its 100-day average, sized to L x w x equity
  let btc: Pending['btc'] = null
  if (w > 0 && prof.btcSym && S[prof.btcSym]) {
    const s = S[prof.btcSym]; const k = lastIdx(s, opts.btcDay ?? day)
    if (k >= BTC_TREND_DAYS) {
      let m = 0; for (let j = k - BTC_TREND_DAYS + 1; j <= k; j++) m += s.c[j]; m /= BTC_TREND_DAYS
      const on = s.c[k] > m
      const target = on ? L * w * equity : 0
      const cur = (book.btc?.units ?? 0) * s.fc[k]
      const why = on ? `Bitcoin $${s.fc[k].toFixed(0)} above its ${BTC_TREND_DAYS}-day average $${m.toFixed(0)}: hold ${(L * w * 100).toFixed(0)}% of the book` : `Bitcoin $${s.fc[k].toFixed(0)} below its ${BTC_TREND_DAYS}-day average $${m.toFixed(0)}: stay out`
      if ((on && cur === 0) || (!on && cur > 0) || (on && Math.abs(cur - target) > BTC_BAND * target)) btc = { targetValue: target, why }
    }
  }
  book.pending = { decidedOn: day, slotSize, stockCap, exits, entries, btc, trimTo, closeFills }
  book.lastDecisionDay = day
  return book.pending
}

/** At the open of `day`: fill yesterday's pending orders. */
export function execute(book: SwingBook, S: Record<string, DSeries>, day: number, idGen: () => string, opts: CoreOpts = {}): SwingTrade[] {
  const prof = PROFILES[book.profile ?? 'COMBO']
  const LEGS = prof.legs
  const L = prof.leverage ?? 1, w = prof.btcWeight ?? 0
  const out: SwingTrade[] = []
  const pend = book.pending; if (!pend || pend.decidedOn >= day) return out
  const openPx = (sym: string) => { const s = S[sym]; const i = s?.idx.get(day); const o = i !== undefined ? s!.fo[i] : NaN; return ok(o) ? o : lastFill(s, day, 'fc') }
  for (const x of pend.exits) {
    const p = book.positions.find(q => q.sym === x.sym); if (!p) continue
    out.push(sellStock(book, p, openPx(p.sym), day, S, x.reason, idGen()))
  }
  if (pend.trimTo) {
    const inv = book.positions.reduce((a, p) => a + p.shares * openPx(p.sym), 0)
    if (inv > pend.trimTo * 1.02) { const k = 1 - pend.trimTo / inv; for (const p of [...book.positions]) out.push(sellStock(book, p, openPx(p.sym), day, S, `trim to keep leverage at ${L}x after a drop`, idGen(), k)) }
  }
  if (pend.btc && prof.btcSym) {
    const s = S[prof.btcSym]
    const px = opts.btcFillPx ?? (() => { const i = s?.idx.get(day); return i !== undefined ? s!.fo[i] : lastFill(s, day, 'fc') })()
    if (ok(px) && px > 0) {
      const units = book.btc?.units ?? 0
      const want = pend.btc.targetValue / px
      const d = want - units
      const cost = Math.abs(d) * px * (prof.btcCost ?? COST)
      if (d > 0) {
        const avg = units > 0 ? (book.btc!.avgPx * units + px * d) / (units + d) : px
        book.btc = { units: units + d, avgPx: avg, sinceDay: book.btc?.sinceDay && units > 0 ? book.btc.sinceDay : day, lastPx: px }
        book.cash -= d * px + cost
        out.push({ id: idGen(), sym: prof.btcSym, leg: 'BTC', action: 'BUY', day, price: px, shares: d, total: d * px + cost, reason: pend.btc.why })
      } else if (d < 0 && units > 0) {
        const sell = -d, avg = book.btc!.avgPx
        const proceeds = sell * px - cost
        const pnl = proceeds - sell * avg
        book.cash += proceeds; book.realized += pnl
        const left = units - sell
        book.btc = left > 1e-12 ? { ...book.btc!, units: left, lastPx: px } : null
        out.push({ id: idGen(), sym: prof.btcSym, leg: 'BTC', action: 'SELL', day, price: px, shares: sell, total: proceeds, pnl, ret: px / avg - 1, net: proceeds / (sell * avg) - 1, reason: pend.btc.why })
      }
    }
  }
  const leveraged = L > 1 || w > 0
  for (const x of pend.entries) {
    const leg = LEGS.find(l => l.leg === x.leg)!
    if (book.positions.filter(p => p.leg === x.leg).length >= leg.slots) continue
    const s = S[x.sym]; const i = s?.idx.get(day); if (!s || i === undefined) continue
    const px = s.fo[i]; if (!ok(px)) continue
    let alloc: number
    if (!leveraged) { alloc = Math.min(book.cash, pend.slotSize); if (alloc < pend.slotSize * 0.5) break }
    else { const inv = book.positions.reduce((a, p) => a + p.shares * openPx(p.sym), 0); alloc = Math.min(pend.slotSize, (pend.stockCap ?? 0) - inv); if (alloc < pend.slotSize * 0.5) break }
    const shares = alloc / (px * (1 + COST))
    book.positions.push({ sym: x.sym, leg: x.leg, entryDay: day, entryPx: px, shares })
    book.cash -= alloc
    out.push({ id: idGen(), sym: x.sym, leg: x.leg, action: 'BUY', day, price: px, shares, total: alloc, reason: x.why })
  }
  book.pending = null
  book.lastExecDay = day
  return out
}
