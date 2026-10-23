/* ═══════════════════════════════════════════════════════════════════════════
   DDCAUSE - what actually caused TROY's worst drops?

     npm run q:ddcause

   Replays the live TROY book (1.8x, all costs) and finds its 3 deepest
   drawdowns (peak to bottom). For each one it splits the loss into Bitcoin,
   breakouts, dips and interest, lists the positions that lost the most, and
   shows what the market (SPY, QQQ, Bitcoin) did over the same stretch.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const P = PROFILES.TROY; P.leverage = 1.8; P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false

/* replay, keeping a snapshot of every holding's value at every close */
const book = newBook(1, dates[START], 'TROY'); let n = 0
const eq: number[] = [], interest: number[] = [], gross: number[] = []
const snaps: Map<string, { v: number; leg: string }>[] = []
const flows: { k: number; key: string; leg: string; amt: number }[] = []   // + cash in, - cash out
const openKey = new Map<string, string>()
for (let t = START; t < N; t++) {
  const d = dates[t]
  const fills: SwingTrade[] = execute(book, S, d, () => String(++n), {})
  for (const f of fills) {
    if (f.action === 'BUY' && f.leg !== 'BTC' && !openKey.has(f.sym)) openKey.set(f.sym, `${f.sym}@${iso(d)}`)
    const key = f.leg === 'BTC' ? 'BTC' : openKey.get(f.sym) ?? `${f.sym}@?`
    flows.push({ k: t - START, key, leg: f.leg, amt: f.action === 'BUY' ? -f.total : f.total })
    if (f.action === 'SELL' && f.leg !== 'BTC' && !book.positions.some(p => p.sym === f.sym)) openKey.delete(f.sym)
  }
  const e = markEquity(book, S, d, { btcDay: d - 1 })
  const m = new Map<string, { v: number; leg: string }>()
  let g = 0
  for (const p of book.positions) { const v = p.shares * (p.lastPx ?? p.entryPx); m.set(openKey.get(p.sym) ?? `${p.sym}@?`, { v, leg: p.leg }); g += v }
  if (book.btc && book.btc.units > 0) { const v = book.btc.units * (book.btc.lastPx ?? book.btc.avgPx); m.set('BTC', { v, leg: 'BTC' }); g += v }
  eq.push(e); interest.push(book.interest ?? 0); gross.push(g / e); snaps.push(m)
  if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
}

/* the 3 deepest non-overlapping drawdowns */
function drawdowns(k = 3) {
  const used: [number, number][] = [], out: { pk: number; tr: number; rec: number; depth: number }[] = []
  for (let r = 0; r < k; r++) {
    let best = { pk: 0, tr: 0, depth: 0 }, pk = -1
    for (let i = 0; i < eq.length; i++) {
      if (used.some(([a, b]) => i >= a && i <= b)) { pk = -1; continue }
      if (pk < 0 || eq[i] > eq[pk]) pk = i
      const dd = 1 - eq[i] / eq[pk]
      if (dd > best.depth) best = { pk, tr: i, depth: dd }
    }
    if (best.depth <= 0) break
    let rec = -1; for (let i = best.tr; i < eq.length; i++) if (eq[i] >= eq[best.pk]) { rec = i; break }
    out.push({ ...best, rec }); used.push([best.pk, rec < 0 ? eq.length - 1 : rec])
  }
  return out
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`
const mret = (sym: string, a: number, b: number) => { const s = S[sym]; if (!s) return NaN; const ia = s.idx.get(dates[START + a]) ?? -1, ib = s.idx.get(dates[START + b]) ?? -1; return ia >= 0 && ib >= 0 ? s.c[ib] / s.c[ia] - 1 : NaN }
console.log(`\nWHAT CAUSED TROY'S WORST DROPS: 1.8x, ${iso(dates[START])} to ${iso(dates[N - 1])}, all costs.\n`)
let rank = 0
for (const dd of drawdowns(3)) {
  rank++
  const base = eq[dd.pk]
  const keys = new Set<string>([...snaps[dd.pk].keys(), ...snaps[dd.tr].keys(), ...flows.filter(f => f.k > dd.pk && f.k <= dd.tr).map(f => f.key)])
  const per: { key: string; leg: string; pnl: number }[] = []
  for (const key of keys) {
    const s0 = snaps[dd.pk].get(key), s1 = snaps[dd.tr].get(key)
    const fl = flows.filter(f => f.key === key && f.k > dd.pk && f.k <= dd.tr)
    const leg = s0?.leg ?? s1?.leg ?? fl[0]?.leg ?? '?'
    per.push({ key, leg, pnl: (s1?.v ?? 0) - (s0?.v ?? 0) + fl.reduce((a, f) => a + f.amt, 0) })
  }
  const byLeg = (l: string) => per.filter(x => x.leg === l).reduce((a, x) => a + x.pnl, 0)
  const intr = interest[dd.tr] - interest[dd.pk]
  const total = eq[dd.tr] - base
  const parts: [string, number][] = [['Bitcoin', byLeg('BTC')], ['Breakouts', byLeg('BREAKOUT')], ['Dips', byLeg('DIP')], ['Interest on borrowing', intr]]
  const resid = total - parts.reduce((a, [, v]) => a + v, 0)
  const avgLev = gross.slice(dd.pk, dd.tr + 1).reduce((a, x) => a + x, 0) / (dd.tr - dd.pk + 1)
  console.log(`#${rank}  -${(100 * dd.depth).toFixed(1)}%   peak ${iso(dates[START + dd.pk])}  ->  bottom ${iso(dates[START + dd.tr])} (${dd.tr - dd.pk} trading days)  ->  ${dd.rec > 0 ? `back to the peak ${iso(dates[START + dd.rec])} (${dd.rec - dd.tr} days later)` : 'not yet recovered'}`)
  console.log(`    where the ${pct(total / base)} came from (share of the book at the peak):`)
  for (const [k, v] of parts) console.log(`      ${k.padEnd(24)} ${pct(v / base).padStart(7)}   (${(100 * v / total).toFixed(0)}% of the drop)`)
  if (Math.abs(resid / base) > 0.002) console.log(`      ${'trading costs / other'.padEnd(24)} ${pct(resid / base).padStart(7)}`)
  console.log(`    market over the same stretch: SPY ${pct(mret('SPY', dd.pk, dd.tr))}, QQQ ${pct(mret('QQQ', dd.pk, dd.tr))}, Bitcoin ${pct(mret('BTC-USD', dd.pk, dd.tr))}. Troy's average leverage: ${avgLev.toFixed(2)}x`)
  console.log(`    biggest losing positions:`)
  for (const x of per.sort((a, b) => a.pnl - b.pnl).slice(0, 8)) console.log(`      ${x.key.padEnd(22)} ${x.leg.padEnd(9)} ${pct(x.pnl / base).padStart(7)} of the book`)
  console.log('')
}
