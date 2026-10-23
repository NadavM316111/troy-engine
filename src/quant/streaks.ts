/* npm run q:streaks   TROY's longest losing (and winning) streaks over 9 years: trades, days, weeks, months. */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const P = PROFILES.TROY; P.leverage = Number(process.argv[2] ?? 1.8); P.exitAtClose = false; P.tomStops = undefined; P.dipStop = undefined; P.dipMarketFilter = false; P.dipSectorFilter = false; P.dipOnePerSector = false

const book = newBook(1_000_000, dates[START], 'TROY'); const eq: number[] = []; const tr: SwingTrade[] = []; let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; tr.push(...execute(book, S, d, () => String(++n), {})); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }

/* longest run of `bad` in a sequence, plus how often a run of at least k happened */
function runs(xs: { win: boolean; label: string }[]) {
  let curL = 0, curW = 0, bestL = 0, bestW = 0, lStart = '', lEnd = '', wStart = '', wEnd = '', cs = '', ws = ''
  const counts = new Map<number, number>()
  const close = (len: number) => { if (len > 0) counts.set(len, (counts.get(len) ?? 0) + 1) }
  for (const x of xs) {
    if (!x.win) { if (curL === 0) cs = x.label; curL++; if (curW) { curW = 0 } if (curL > bestL) { bestL = curL; lStart = cs; lEnd = x.label } }
    else { close(curL); curL = 0; if (curW === 0) ws = x.label; curW++; if (curW > bestW) { bestW = curW; wStart = ws; wEnd = x.label } }
  }
  close(curL)
  const atLeast = (k: number) => [...counts.entries()].filter(([len]) => len >= k).reduce((a, [, c]) => a + c, 0)
  return { bestL, lStart, lEnd, bestW, wStart, wEnd, atLeast }
}
const sells = tr.filter(x => x.action === 'SELL' && !x.reason.startsWith('trim'))
const stockSells = sells.filter(x => x.leg !== 'BTC')
const T = runs(stockSells.map(x => ({ win: (x.net ?? 0) > 0, label: `${iso(x.day)} ${x.sym}` })))
const D = runs(eq.slice(1).map((v, k) => ({ win: v > eq[k], label: iso(dates[START + k + 1]) })))
const wk: { win: boolean; label: string }[] = []; for (let k = 5; k < eq.length; k += 5) wk.push({ win: eq[k] > eq[k - 5], label: iso(dates[START + k]) })
const W = runs(wk)
const me = new Map<string, number>(); eq.forEach((_, k) => me.set(iso(dates[START + k]).slice(0, 7), k))
const mk = [...me.entries()]; const mo: { win: boolean; label: string }[] = []; for (let i = 1; i < mk.length; i++) mo.push({ win: eq[mk[i][1]] > eq[mk[i - 1][1]], label: mk[i][0] })
const M = runs(mo)
const yrs = (N - START) / 252
console.log(`\nTROY STREAKS: live code, ${P.leverage}x, all costs, ${iso(dates[START])} to ${iso(dates[N - 1])} (${yrs.toFixed(1)} years)\n`)
const row = (l: string, r: ReturnType<typeof runs>) => console.log(`${l.padEnd(20)}${String(r.bestL).padStart(6)}   ${(r.lStart + ' -> ' + r.lEnd).padEnd(46)}${String(r.bestW).padStart(6)}   ${r.wStart} -> ${r.wEnd}`)
console.log(`${''.padEnd(20)}${'longest LOSING streak'.padEnd(55)}${'longest WINNING streak'}`)
row('stock trades', T)
row('days', D)
row('weeks', W)
row('months', M)
console.log(`\nHow often losing streaks of this length happened (stock trades, in a row):`)
for (const k of [5, 7, 9, 10, 12, 15]) console.log(`  ${String(k).padStart(2)}+ losses in a row: ${T.atLeast(k)} times (about ${(T.atLeast(k) / yrs).toFixed(1)} a year)`)
console.log(`\nLosing days in a row: 6+ happened ${D.atLeast(6)} times, 8+ ${D.atLeast(8)} times. Losing months in a row: 3+ happened ${M.atLeast(3)} times.\n`)
