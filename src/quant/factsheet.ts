/* ═══════════════════════════════════════════════════════════════════════════
   FACTSHEET - every number on the 9-year sheet, measured for TODAY's Troy and
   the NEW Troy (1.6x + earnings drift 0.6x, 20 days), real engine, all costs.

     npm run q:factsheet         (needs q:earnings-fetch once)
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const mon = (d: number) => new Date(d * 86400000).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
setEarnings(ev)

type Side = 'STOCKS' | 'EARN' | 'BTC'
function run(L: number, drift: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = drift ? { jump: 0.03, hold: 20, weight: drift, slots: 10 } : undefined
  const book = newBook(1_000_000, dates[START], 'TROY'); let n = 0
  const eq: number[] = [], lev: number[] = [], tr: SwingTrade[] = []
  const val: Record<Side, number> = { STOCKS: 0, EARN: 0, BTC: 0 }; const daily: Record<Side | 'INT', number[]> = { STOCKS: [], EARN: [], BTC: [], INT: [] }
  let prevEq = 1_000_000, prevInt = 0
  const trips: { start: number; end: number; pnl: number; bought: number }[] = []; let trip: { start: number; pnl: number; bought: number } | null = null
  for (let t = START; t < N; t++) {
    const d = dates[t]; const fills = execute(book, S, d, () => String(++n), {})
    const flow: Record<Side, number> = { STOCKS: 0, EARN: 0, BTC: 0 }
    for (const f of fills) {
      tr.push(f); const sd: Side = f.leg === 'BTC' ? 'BTC' : f.leg === 'EARN' ? 'EARN' : 'STOCKS'
      flow[sd] += f.action === 'BUY' ? -f.total : f.total
      if (f.leg === 'BTC') { if (f.action === 'BUY') { if (!trip) trip = { start: d, pnl: 0, bought: 0 }; trip.pnl -= f.total; trip.bought += f.total } else if (trip) { trip.pnl += f.total; if (!book.btc) { trips.push({ ...trip, end: d }); trip = null } } }
    }
    const e = markEquity(book, S, d, { btcDay: d - 1 }); eq.push(e)
    const v: Record<Side, number> = { STOCKS: 0, EARN: 0, BTC: 0 }
    for (const p of book.positions) v[p.leg === 'EARN' ? 'EARN' : 'STOCKS'] += p.shares * (p.lastPx ?? p.entryPx)
    v.BTC = book.btc ? book.btc.units * (book.btc.lastPx ?? book.btc.avgPx) : 0
    lev.push((v.STOCKS + v.EARN + v.BTC) / e)
    if (t > START) for (const sd of ['STOCKS', 'EARN', 'BTC'] as Side[]) daily[sd].push((v[sd] - val[sd] + flow[sd]) / prevEq)
    Object.assign(val, v)
    if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
    if (t > START) daily.INT.push(((book.interest ?? 0) - prevInt) / prevEq)
    prevInt = book.interest ?? 0; prevEq = markEquity(book, S, d, { btcDay: d - 1 })
  }
  if (trip) trips.push({ ...trip, end: dates[N - 1], pnl: trip.pnl + (book.btc ? book.btc.units * (book.btc.lastPx ?? 0) : 0) })
  P.leverage = 1.8; P.earnDrift = undefined
  return { eq, lev, tr, daily, trips }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 } return va && vb ? c / Math.sqrt(va * vb) : 0 }
const cumDD = (a: number[]) => { let c = 0, pk = 0, m = 0; for (const x of a) { c += x; pk = Math.max(pk, c); m = Math.max(m, pk - c) } return m }
function runs(xs: { win: boolean; label: string }[]) { let cl = 0, cw = 0, bl = 0, bw = 0, ls = '', le = '', ws = '', we = '', s1 = '', s2 = ''
  for (const x of xs) { if (!x.win) { if (!cl) s1 = x.label; cl++; cw = 0; if (cl > bl) { bl = cl; ls = s1; le = x.label } } else { if (!cw) s2 = x.label; cw++; cl = 0; if (cw > bw) { bw = cw; ws = s2; we = x.label } } }
  return { bl, ls, le, bw, ws, we } }

function measure(r: ReturnType<typeof run>) {
  const { eq } = r, rets = eq.slice(1).map((v, k) => v / eq[k] - 1), yrs = rets.length / 252
  let pk = eq[0], mdd = 0; for (const v of eq) { pk = Math.max(pk, v); mdd = Math.max(mdd, 1 - v / pk) }
  const st = (a: number[]) => mean(a) / sd(a) * Math.sqrt(252)
  let seed = 9; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const mc: number[] = []; for (let k = 0; k < 2000; k++) { let v = 1, p2 = 1, m = 0, len = 0; while (len < rets.length) { const s0 = Math.floor(rnd() * (rets.length - 20)); for (let j = 0; j < 20 && len < rets.length; j++, len++) { v *= 1 + rets[s0 + j]; p2 = Math.max(p2, v); m = Math.max(m, 1 - v / p2) } } mc.push(m) }
  mc.sort((a, b) => a - b)
  const closed = r.tr.filter(t => t.action === 'SELL' && !t.reason.startsWith('trim') && t.leg !== 'BTC')
  const legStats = (q: SwingTrade[]) => { const w = q.filter(t => (t.net ?? 0) > 0), l = q.filter(t => (t.net ?? 0) <= 0); const av = (z: SwingTrade[]) => z.length ? 100 * mean(z.map(t => t.net ?? 0)) : 0
    return { n: q.length, perYr: q.length / yrs, win: q.length ? 100 * w.length / q.length : 0, aw: av(w), al: av(l), worst: q.length ? Math.min(...q.map(t => t.net ?? 0)) : 0, hold: q.length ? mean(q.map(t => t.holdDays ?? 0)) : 0 } }
  const bt = r.trips.map(x => ({ ...x, ret: x.pnl / Math.max(1, x.bought) }))
  const btW = bt.filter(x => x.ret > 0), btL = bt.filter(x => x.ret <= 0)
  const allWins = closed.filter(t => (t.net ?? 0) > 0).length + btW.length, allN = closed.length + bt.length
  const years = new Map<string, number[]>(); eq.forEach((_, k) => { const y = iso(dates[START + k]).slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y)!.push(k) })
  let prevK = 0; const yr: { y: string; r: number; full: boolean }[] = []
  for (const [y, ks] of years) { const a = ks[0] === 0 ? 0 : prevK, b = ks[ks.length - 1]; yr.push({ y, r: eq[b] / eq[a] - 1, full: ks.length >= 240 }); prevK = b }
  const fullYr = yr.filter(x => x.full)
  const bestT = [...closed].sort((a, b) => (b.net ?? 0) - (a.net ?? 0))[0], worstT = [...closed].sort((a, b) => (a.net ?? 0) - (b.net ?? 0))[0]
  const dayR = rets.map((x, k) => ({ x, d: dates[START + k + 1] }))
  const bestD = dayR.reduce((a, b) => b.x > a.x ? b : a), worstD = dayR.reduce((a, b) => b.x < a.x ? b : a)
  const T = runs(closed.map(t => ({ win: (t.net ?? 0) > 0, label: `${iso(t.day)}` })))
  const D = runs(dayR.map(x => ({ win: x.x > 0, label: iso(x.d) })))
  const wk: { win: boolean; label: string }[] = []; for (let k = 5; k < eq.length; k += 5) wk.push({ win: eq[k] > eq[k - 5], label: iso(dates[START + k]) })
  const me = new Map<string, number>(); eq.forEach((_, k) => me.set(iso(dates[START + k]).slice(0, 7), k)); const mk = [...me.entries()]
  const mo: { win: boolean; label: string }[] = []; for (let i = 1; i < mk.length; i++) mo.push({ win: eq[mk[i][1]] > eq[mk[i - 1][1]], label: mk[i][0] })
  const W = runs(wk), M = runs(mo)
  const sides = (['STOCKS', 'EARN', 'BTC'] as Side[]).map(s => ({ s, a: r.daily[s] }))
  const vols = sides.map(x => sd(x.a)); const C = sides.map(x => sides.map(y => corr(x.a, y.a)))
  const cov = (i: number, j: number) => C[i][j] * vols[i] * vols[j]
  const totVar = sides.reduce((acc, _, i) => acc + sides.reduce((a2, __, j) => a2 + cov(i, j), 0), 0)
  const side = (i: number) => { const a = sides[i].a; return { profit: 100 * mean(a) * 252, sh: sd(a) > 0 ? st(a) : 0, risk: totVar > 0 ? 100 * sides.reduce((s2, _, j) => s2 + cov(i, j), 0) / totVar : 0, worstDay: 100 * Math.min(...a), dd: 100 * cumDD(a), vol: 100 * sd(a) * Math.sqrt(252) } }
  return {
    sharpe: st(rets), isSh: st(rets.slice(0, SPLIT - START - 1)), oosSh: st(rets.slice(SPLIT - START - 1)),
    cagr: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 252 / rets.length) - 1), dayGeo: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 1 / rets.length) - 1), dayAvg: 100 * mean(rets),
    vol: 100 * sd(rets) * Math.sqrt(252), daySwing: 100 * sd(rets), mdd: 100 * mdd, mc90: 100 * mc[Math.floor(0.9 * mc.length)],
    lev: mean(r.lev), levPeak: Math.max(...r.lev), endValue: eq[eq.length - 1],
    winAll: 100 * allWins / allN, totalTrades: allN, stock: legStats(closed), brk: legStats(closed.filter(t => t.leg === 'BREAKOUT')), dip: legStats(closed.filter(t => t.leg === 'DIP')), earn: legStats(closed.filter(t => t.leg === 'EARN')),
    btc: { n: bt.length, perYr: bt.length / yrs, win: 100 * btW.length / Math.max(1, bt.length), aw: btW.length ? 100 * mean(btW.map(x => x.ret)) : 0, al: btL.length ? 100 * mean(btL.map(x => x.ret)) : 0, worst: Math.min(...bt.map(x => x.ret)), best: bt.reduce((a, b) => b.ret > a.ret ? b : a), worstS: bt.reduce((a, b) => b.ret < a.ret ? b : a), hold: mean(bt.map(x => (x.end - x.start) * 5 / 7)) },
    bestYr: fullYr.reduce((a, b) => b.r > a.r ? b : a), worstYr: fullYr.reduce((a, b) => b.r < a.r ? b : a), upYears: fullYr.filter(x => x.r > 0).length, nYears: fullYr.length, yr,
    bestT, worstT, bestD, worstD, T, D, W, M, sides: [0, 1, 2].map(side), interest: 100 * mean(r.daily.INT) * 252, corrSB: C[0][2], corrSE: C[0][1], corrEB: C[1][2],
  }
}
const p = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
const R = (l: string, a: string, b: string) => console.log(`${l.padEnd(46)}${a.padStart(26)}${b.padStart(26)}`)
const A = measure(run(1.8, 0)), B = measure(run(1.6, 0.6))
console.log(`\nTROY 9-YEAR FACT SHEET: ${iso(dates[START])} to ${iso(dates[N - 1])}, real engine, all costs (stocks 0.05%/side, Bitcoin 0.15%, no commission, borrowing 5%/yr)\n`)
R('', 'TODAY (1.8x)', 'NEW (1.6x + drift 0.6x)')
R('KEY RESULTS', '', '')
R('  Sharpe ratio', A.sharpe.toFixed(2), B.sharpe.toFixed(2))
R('  Sharpe 2017-2023 / 2024-2026', `${A.isSh.toFixed(2)} / ${A.oosSh.toFixed(2)}`, `${B.isSh.toFixed(2)} / ${B.oosSh.toFixed(2)}`)
R('  Per year (compounded)', p(A.cagr), p(B.cagr))
R('  Per day (compounded)', p(A.dayGeo, 3), p(B.dayGeo, 3))
R('  Per day (simple average of daily returns)', p(A.dayAvg, 3), p(B.dayAvg, 3))
R('  $1,000,000 became', `$${Math.round(A.endValue).toLocaleString('en-US')}`, `$${Math.round(B.endValue).toLocaleString('en-US')}`)
R('  Win rate (all closed trades incl. Bitcoin)', `${A.winAll.toFixed(1)}%`, `${B.winAll.toFixed(1)}%`)
R('  Total trades', String(A.totalTrades), String(B.totalTrades))
R('TRADES', '', '')
for (const [l, k] of [['  Stock trades (breakout + dip + earnings)', 'stock'], ['  Breakout', 'brk'], ['  Dip', 'dip'], ['  Earnings drift', 'earn']] as const) R(l, `${(A as any)[k].n} (${(A as any)[k].perYr.toFixed(0)}/yr)`, `${(B as any)[k].n} (${(B as any)[k].perYr.toFixed(0)}/yr)`)
R('  Bitcoin trades', `${A.btc.n} (${A.btc.perYr.toFixed(1)}/yr)`, `${B.btc.n} (${B.btc.perYr.toFixed(1)}/yr)`)
R('  Average hold: stocks / Bitcoin (trading days)', `${A.stock.hold.toFixed(0)} / ${A.btc.hold.toFixed(0)}`, `${B.stock.hold.toFixed(0)} / ${B.btc.hold.toFixed(0)}`)
R('BREAKOUT / DIP / EARNINGS', '', '')
for (const [l, k] of [['  Breakout', 'brk'], ['  Dip', 'dip'], ['  Earnings drift', 'earn'], ['  All stock trades', 'stock']] as const) { const a = (A as any)[k], b = (B as any)[k]; R(`${l}: win / avg win / avg loss`, a.n ? `${a.win.toFixed(0)}% / ${p(a.aw)} / ${p(a.al)}` : '-', b.n ? `${b.win.toFixed(0)}% / ${p(b.aw)} / ${p(b.al)}` : '-') }
R('BEST AND WORST', '', '')
R('  Best year / worst year (full years)', `${p(100 * A.bestYr.r, 0)} (${A.bestYr.y}) / ${p(100 * A.worstYr.r, 0)} (${A.worstYr.y})`, `${p(100 * B.bestYr.r, 0)} (${B.bestYr.y}) / ${p(100 * B.worstYr.r, 0)} (${B.worstYr.y})`)
R('  Up years', `${A.upYears} of ${A.nYears}`, `${B.upYears} of ${B.nYears}`)
R('  Best single trade', `${p(100 * (A.bestT.net ?? 0))} ${A.bestT.sym}`, `${p(100 * (B.bestT.net ?? 0))} ${B.bestT.sym}`)
R('  Worst single trade', `${p(100 * (A.worstT.net ?? 0))} ${A.worstT.sym} ${mon(A.worstT.day)}`, `${p(100 * (B.worstT.net ?? 0))} ${B.worstT.sym} ${mon(B.worstT.day)}`)
R('  Best day / worst day', `${p(100 * A.bestD.x)} / ${p(100 * A.worstD.x)}`, `${p(100 * B.bestD.x)} / ${p(100 * B.worstD.x)}`)
R('  Worst Bitcoin trade', p(100 * A.btc.worst), p(100 * B.btc.worst))
R('  Bitcoin best stretch', `${p(100 * A.btc.best.ret, 0)} ${mon(A.btc.best.start)}-${mon(A.btc.best.end)}`, `${p(100 * B.btc.best.ret, 0)} ${mon(B.btc.best.start)}-${mon(B.btc.best.end)}`)
R('  Bitcoin worst stretch', `${p(100 * A.btc.worstS.ret, 0)} ${mon(A.btc.worstS.start)}-${mon(A.btc.worstS.end)}`, `${p(100 * B.btc.worstS.ret, 0)} ${mon(B.btc.worstS.start)}-${mon(B.btc.worstS.end)}`)
R('RISK', '', '')
R('  Volatility per year / normal day swing', `${A.vol.toFixed(1)}% / +-${A.daySwing.toFixed(1)}%`, `${B.vol.toFixed(1)}% / +-${B.daySwing.toFixed(1)}%`)
R('  Max drawdown', `-${A.mdd.toFixed(1)}%`, `-${B.mdd.toFixed(1)}%`)
R('  Monte Carlo drop (bad luck, 90th pct)', `-${A.mc90.toFixed(0)}%`, `-${B.mc90.toFixed(0)}%`)
R('  Leverage: average / peak', `${A.lev.toFixed(2)}x / ${A.levPeak.toFixed(2)}x`, `${B.lev.toFixed(2)}x / ${B.levPeak.toFixed(2)}x`)
R('  Interest on borrowing per year', p(A.interest), p(B.interest))
R('SIDES: stocks / earnings / Bitcoin', '', '')
for (const [i, l] of [[0, 'Stocks (breakout + dip)'], [1, 'Earnings drift'], [2, 'Bitcoin']] as [number, string][]) {
  const a = A.sides[i], b = B.sides[i]
  R(`  ${l}: profit/yr, Sharpe`, i === 1 ? '-' : `${p(a.profit)}, ${a.sh.toFixed(2)}`, `${p(b.profit)}, ${b.sh.toFixed(2)}`)
  R(`  ${l}: share of risk, worst day, worst drop`, i === 1 ? '-' : `${a.risk.toFixed(0)}%, ${p(a.worstDay)}, -${a.dd.toFixed(1)}%`, `${b.risk.toFixed(0)}%, ${p(b.worstDay)}, -${b.dd.toFixed(1)}%`)
}
R('  Move together (stocks-Bitcoin / stocks-earn / earn-Bitcoin)', A.corrSB.toFixed(2), `${B.corrSB.toFixed(2)} / ${B.corrSE.toFixed(2)} / ${B.corrEB.toFixed(2)}`)
R('STREAKS (longest)', '', '')
for (const [l, k] of [['trades', 'T'], ['days', 'D'], ['weeks', 'W'], ['months', 'M']] as const) R(`  Winning / losing ${l}`, `${(A as any)[k].bw} / ${(A as any)[k].bl}`, `${(B as any)[k].bw} / ${(B as any)[k].bl}`)
console.log(`\nYEAR BY YEAR (${'TODAY'.padStart(8)} ${'NEW'.padStart(8)})`)
for (let i = 0; i < A.yr.length; i++) console.log(`  ${A.yr[i].y}${A.yr[i].full ? ' ' : '*'}${p(100 * A.yr[i].r, 0).padStart(10)}${p(100 * B.yr[i].r, 0).padStart(9)}`)
console.log(`  * partial year\n`)
