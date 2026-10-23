/* ═══════════════════════════════════════════════════════════════════════════
   WINDOWFACTS - every number on the 9-year sheet, for any window, Troy's
   algorithm (1.6x + earnings drift 0.6x), fresh $1,000,000 at the start of
   each window, real engine, all costs. Default windows = the 5-year run and
   the 5 random weeks from Oct 2026.

     npm run q:windowfacts
     npm run q:windowfacts -- 2019-08-30:2024-09-04 2018-01-29:2018-02-05
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
function run(L: number, drift: number, t0: number, t1: number) {
  const P = PROFILES.TROY; P.leverage = L; P.exitAtClose = false; P.earnDrift = drift ? { jump: 0.03, hold: 20, weight: drift, slots: 10 } : undefined
  const book = newBook(1_000_000, dates[t0], 'TROY'); let n = 0
  const eq: number[] = [], lev: number[] = [], tr: SwingTrade[] = []
  const val: Record<Side, number> = { STOCKS: 0, EARN: 0, BTC: 0 }; const daily: Record<Side | 'INT', number[]> = { STOCKS: [], EARN: [], BTC: [], INT: [] }
  let prevEq = 1_000_000, prevInt = 0
  const trips: { start: number; end: number; pnl: number; bought: number }[] = []; let trip: { start: number; pnl: number; bought: number } | null = null
  for (let t = t0; t <= t1; t++) {
    const d = dates[t]; const fills = t > t0 ? execute(book, S, d, () => String(++n), {}) : []
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
    if (t > t0) for (const sd of ['STOCKS', 'EARN', 'BTC'] as Side[]) daily[sd].push((v[sd] - val[sd] + flow[sd]) / prevEq)
    Object.assign(val, v)
    if (t < t1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
    if (t > t0) daily.INT.push(((book.interest ?? 0) - prevInt) / prevEq)
    prevInt = book.interest ?? 0; prevEq = markEquity(book, S, d, { btcDay: d - 1 })
  }
  const openAtEnd = book.positions.map(p => ({ sym: p.sym, leg: p.leg, ret: (p.lastPx ?? p.entryPx) / p.entryPx - 1 }))
  if (trip) trips.push({ ...trip, end: dates[t1], pnl: trip.pnl + (book.btc ? book.btc.units * (book.btc.lastPx ?? 0) : 0) })
  return { eq, lev, tr, daily, trips, t0, openAtEnd }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 } return va && vb ? c / Math.sqrt(va * vb) : 0 }
const cumDD = (a: number[]) => { let c = 0, pk = 0, m = 0; for (const x of a) { c += x; pk = Math.max(pk, c); m = Math.max(m, pk - c) } return m }
function runs(xs: { win: boolean; label: string }[]) { let cl = 0, cw = 0, bl = 0, bw = 0, ls = '', le = '', ws = '', we = '', s1 = '', s2 = ''
  for (const x of xs) { if (!x.win) { if (!cl) s1 = x.label; cl++; cw = 0; if (cl > bl) { bl = cl; ls = s1; le = x.label } } else { if (!cw) s2 = x.label; cw++; cl = 0; if (cw > bw) { bw = cw; ws = s2; we = x.label } } }
  return { bl, ls, le, bw, ws, we } }

function measure(r: ReturnType<typeof run>) {
  const T0 = r.t0
  const { eq } = r, rets = eq.slice(1).map((v, k) => v / eq[k] - 1), yrs = rets.length / 252
  let pk = eq[0], mdd = 0; for (const v of eq) { pk = Math.max(pk, v); mdd = Math.max(mdd, 1 - v / pk) }
  const st = (a: number[]) => a.length > 2 && sd(a) > 0 ? mean(a) / sd(a) * Math.sqrt(252) : 0
  let seed = 9; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const mc: number[] = []; for (let k = 0; k < (rets.length > 60 ? 2000 : 0); k++) { let v = 1, p2 = 1, m = 0, len = 0; while (len < rets.length) { const s0 = Math.floor(rnd() * (rets.length - 20)); for (let j = 0; j < 20 && len < rets.length; j++, len++) { v *= 1 + rets[s0 + j]; p2 = Math.max(p2, v); m = Math.max(m, 1 - v / p2) } } mc.push(m) }
  mc.sort((a, b) => a - b); if (!mc.length) mc.push(NaN)
  const closed = r.tr.filter(t => t.action === 'SELL' && !t.reason.startsWith('trim') && t.leg !== 'BTC')
  const legStats = (q: SwingTrade[]) => { const w = q.filter(t => (t.net ?? 0) > 0), l = q.filter(t => (t.net ?? 0) <= 0); const av = (z: SwingTrade[]) => z.length ? 100 * mean(z.map(t => t.net ?? 0)) : 0
    return { n: q.length, perYr: q.length / yrs, win: q.length ? 100 * w.length / q.length : 0, aw: av(w), al: av(l), worst: q.length ? Math.min(...q.map(t => t.net ?? 0)) : 0, hold: q.length ? mean(q.map(t => t.holdDays ?? 0)) : 0 } }
  const bt = r.trips.map(x => ({ ...x, ret: x.pnl / Math.max(1, x.bought) }))
  const btW = bt.filter(x => x.ret > 0), btL = bt.filter(x => x.ret <= 0)
  const allWins = closed.filter(t => (t.net ?? 0) > 0).length + btW.length, allN = closed.length + bt.length
  const years = new Map<string, number[]>(); eq.forEach((_, k) => { const y = iso(dates[T0 + k]).slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y)!.push(k) })
  let prevK = 0; const yr: { y: string; r: number; full: boolean }[] = []
  for (const [y, ks] of years) { const a = ks[0] === 0 ? 0 : prevK, b = ks[ks.length - 1]; yr.push({ y, r: eq[b] / eq[a] - 1, full: ks.length >= 240 }); prevK = b }
  const fullYr = yr.filter(x => x.full)
  const bestT = [...closed].sort((a, b) => (b.net ?? 0) - (a.net ?? 0))[0], worstT = [...closed].sort((a, b) => (a.net ?? 0) - (b.net ?? 0))[0]
  const dayR = rets.map((x, k) => ({ x, d: dates[T0 + k + 1] }))
  const bestD = dayR.reduce((a, b) => b.x > a.x ? b : a), worstD = dayR.reduce((a, b) => b.x < a.x ? b : a)
  const T = runs(closed.map(t => ({ win: (t.net ?? 0) > 0, label: `${iso(t.day)}` })))
  const D = runs(dayR.map(x => ({ win: x.x > 0, label: iso(x.d) })))
  const wk: { win: boolean; label: string }[] = []; for (let k = 5; k < eq.length; k += 5) wk.push({ win: eq[k] > eq[k - 5], label: iso(dates[T0 + k]) })
  const me = new Map<string, number>(); eq.forEach((_, k) => me.set(iso(dates[T0 + k]).slice(0, 7), k)); const mk = [...me.entries()]
  const mo: { win: boolean; label: string }[] = []; for (let i = 1; i < mk.length; i++) mo.push({ win: eq[mk[i][1]] > eq[mk[i - 1][1]], label: mk[i][0] })
  const W = runs(wk), M = runs(mo)
  const sides = (['STOCKS', 'EARN', 'BTC'] as Side[]).map(s => ({ s, a: r.daily[s] }))
  const vols = sides.map(x => sd(x.a)); const C = sides.map(x => sides.map(y => corr(x.a, y.a)))
  const cov = (i: number, j: number) => C[i][j] * vols[i] * vols[j]
  const totVar = sides.reduce((acc, _, i) => acc + sides.reduce((a2, __, j) => a2 + cov(i, j), 0), 0)
  const side = (i: number) => { const a = sides[i].a; return { profit: 100 * mean(a) * 252, sh: sd(a) > 0 ? st(a) : 0, risk: totVar > 0 ? 100 * sides.reduce((s2, _, j) => s2 + cov(i, j), 0) / totVar : 0, worstDay: 100 * Math.min(...a), dd: 100 * cumDD(a), vol: 100 * sd(a) * Math.sqrt(252) } }
  return {
    sharpe: st(rets), isSh: st(rets), oosSh: st(rets),
    cagr: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 252 / rets.length) - 1), dayGeo: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 1 / rets.length) - 1), dayAvg: 100 * mean(rets),
    vol: 100 * sd(rets) * Math.sqrt(252), daySwing: 100 * sd(rets), mdd: 100 * mdd, mc90: 100 * mc[Math.floor(0.9 * mc.length)],
    lev: mean(r.lev), levPeak: Math.max(...r.lev), endValue: eq[eq.length - 1],
    winAll: 100 * allWins / allN, totalTrades: allN, stock: legStats(closed), brk: legStats(closed.filter(t => t.leg === 'BREAKOUT')), dip: legStats(closed.filter(t => t.leg === 'DIP')), earn: legStats(closed.filter(t => t.leg === 'EARN')),
    btc: { n: bt.length, perYr: bt.length / yrs, win: 100 * btW.length / Math.max(1, bt.length), aw: btW.length ? 100 * mean(btW.map(x => x.ret)) : 0, al: btL.length ? 100 * mean(btL.map(x => x.ret)) : 0, worst: bt.length ? Math.min(...bt.map(x => x.ret)) : NaN, best: bt.length ? bt.reduce((a, b) => b.ret > a.ret ? b : a) : null, worstS: bt.length ? bt.reduce((a, b) => b.ret < a.ret ? b : a) : null, hold: bt.length ? mean(bt.map(x => (x.end - x.start) * 5 / 7)) : NaN },
    bestYr: fullYr.length ? fullYr.reduce((a, b) => b.r > a.r ? b : a) : null, worstYr: fullYr.length ? fullYr.reduce((a, b) => b.r < a.r ? b : a) : null, upYears: fullYr.filter(x => x.r > 0).length, nYears: fullYr.length, yr,
    bestT, worstT, bestD, worstD, rets, days: dayR, trades: r.tr, openAtEnd: r.openAtEnd, T, D, W, M, sides: [0, 1, 2].map(side), interest: 100 * mean(r.daily.INT) * 252, corrSB: C[0][2], corrSE: C[0][1], corrEB: C[1][2],
  }
}
const p = (x: number, d = 1) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : '-'
const money = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
const md = (d: number) => new Date(d * 86400000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const at = (s: string) => dates.findIndex(d => d >= dayNum(s))
const args = process.argv.slice(2).filter(a => a.includes(':'))
const windows: [string, number, number][] = (args.length ? args : ['2019-08-30:2024-09-04', '2018-01-29:2018-02-05', '2018-04-16:2018-04-23', '2019-03-04:2019-03-11', '2020-12-14:2020-12-21', '2023-10-30:2023-11-06'])
  .map(a => { const [s, e] = a.split(':'); return [a, at(s), at(e)] as [string, number, number] })
const P0 = PROFILES.TROY
for (const [label, t0, t1] of windows) {
  const r = run(1.6, 0.6, t0, t1), m = measure(r)
  const long = t1 - t0 > 60
  const spy = S['SPY'].c[S['SPY'].idx.get(dates[t1])!] / S['SPY'].c[S['SPY'].idx.get(dates[t0])!] - 1
  const bs = S['BTC-USD']; const bc = (d: number) => { for (let k = bs.days.length - 1; k >= 0; k--) if (bs.days[k] <= d - 1) return bs.c[k]; return NaN }
  const btcR = bc(dates[t1]) / bc(dates[t0]) - 1
  console.log(`\n================ WINDOW ${md(dates[t0])} to ${md(dates[t1])} (${t1 - t0} trading days), Troy 1.6x + earnings drift 0.6x, fresh $1,000,000 ================`)
  console.log(`market: SPY ${p(100 * spy)}, Bitcoin ${p(100 * btcR)}`)
  console.log(`end value ${money(m.endValue)} (${p(100 * (m.endValue / 1e6 - 1))}); per year ${long ? p(m.cagr) : '-'}; per day compounded ${p(m.dayGeo, 3)}; simple avg ${p(m.dayAvg, 3)}`)
  console.log(`Sharpe ${long ? m.sharpe.toFixed(2) : '- (too short)'}; volatility ${long ? m.vol.toFixed(1) + '%' : '-'}; normal day swing +-${m.daySwing.toFixed(1)}%; max drawdown -${m.mdd.toFixed(1)}%; Monte Carlo ${long ? '-' + m.mc90.toFixed(0) + '%' : '-'}`)
  console.log(`leverage avg ${m.lev.toFixed(2)}x / peak ${m.levPeak.toFixed(2)}x; borrowing ${p(m.interest)} per year`)
  console.log(`closed trades ${m.totalTrades} (stocks ${m.stock.n}: breakout ${m.brk.n}, dip ${m.dip.n}, earnings ${m.earn.n}; Bitcoin ${m.btc.n}); win rate all ${Number.isFinite(m.winAll) ? m.winAll.toFixed(1) + '%' : '-'}`)
  for (const [l, k] of [['breakout', 'brk'], ['dip', 'dip'], ['earnings', 'earn'], ['all stocks', 'stock']] as const) { const x = (m as any)[k]; if (x.n) console.log(`  ${l}: win ${x.win.toFixed(0)}%, avg win ${p(x.aw)}, avg loss ${p(x.al)}, avg hold ${x.hold.toFixed(0)} days`) }
  if (m.btc.n) console.log(`  Bitcoin: ${m.btc.n} trades, win ${m.btc.win.toFixed(0)}%, avg win ${p(m.btc.aw)}, avg loss ${p(m.btc.al)}, worst ${p(100 * m.btc.worst)}`)
  if (m.bestT) console.log(`best trade ${p(100 * (m.bestT.net ?? 0))} ${m.bestT.sym} (${m.bestT.leg}); worst trade ${p(100 * (m.worstT.net ?? 0))} ${m.worstT.sym} (${m.worstT.leg}, ${md(m.worstT.day)})`)
  console.log(`best day ${p(100 * m.bestD.x)} (${md(m.bestD.d)}); worst day ${p(100 * m.worstD.x)} (${md(m.worstD.d)}); up days ${(100 * m.rets.filter(x => x > 0).length / m.rets.length).toFixed(0)}%`)
  if (m.btc.best && long) console.log(`Bitcoin best stretch ${p(100 * m.btc.best.ret, 0)} (${md(m.btc.best.start)} to ${md(m.btc.best.end)}); worst ${p(100 * m.btc.worstS!.ret, 0)} (${md(m.btc.worstS!.start)} to ${md(m.btc.worstS!.end)})`)
  const names = ['stocks', 'earnings', 'Bitcoin']
  console.log(`sides (profit${long ? '/yr' : ' over window'}, Sharpe, share of risk, worst day, worst drop): ${m.sides.map((s, i) => `${names[i]} ${long ? p(s.profit) : p(100 * r.daily[(['STOCKS', 'EARN', 'BTC'] as const)[i]].reduce((a, b) => a + b, 0))}, ${long ? s.sh.toFixed(2) : '-'}, ${s.risk.toFixed(0)}%, ${p(s.worstDay)}, -${s.dd.toFixed(1)}%`).join(' | ')}`)
  console.log(`streaks winning/losing: trades ${m.T.bw}/${m.T.bl}, days ${m.D.bw}/${m.D.bl}${long ? `, weeks ${m.W.bw}/${m.W.bl}, months ${m.M.bw}/${m.M.bl}` : ''}`)
  if (long) { console.log(`year by year: ${m.yr.map(y => `${y.y}${y.full ? '' : '*'} ${p(100 * y.r, 1)}`).join(', ')}`); console.log(`worst drop dates: see q:fiveyear`) }
  if (!long) {
    console.log(`day by day:`)
    let prev = 1e6
    for (let k = 1; k < r.eq.length; k++) { const d = dates[t0 + k]; const f = m.trades.filter(x => x.day === d)
      console.log(`  ${md(d)}  ${money(r.eq[k])}  ${p(100 * (r.eq[k] / prev - 1), 2)}  ${f.map(x => `${x.action} ${x.sym === 'BTC-USD' ? 'BTC' : x.sym} ${x.leg}${x.action === 'SELL' && x.net !== undefined ? ' ' + p(100 * x.net) : ''}`).join(', ')}`); prev = r.eq[k] }
    console.log(`still open at the end: ${m.openAtEnd.map(o => `${o.sym === 'BTC-USD' ? 'BTC' : o.sym} ${o.leg} ${p(100 * o.ret)}`).join(', ') || 'none'}`)
  }
}
console.log('')
