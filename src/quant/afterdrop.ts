/* ═══════════════════════════════════════════════════════════════════════════
   AFTER A BAD WEEK - what did TROY do next, every time it had a week like this?

     npm run q:afterdrop

   Replays the live TROY book (1.8x, all costs) over ~9 years, finds every
   5-trading-day stretch that lost 6% or more (non-overlapping), and reports
   what happened over the following 1 and 3 months. Compared with ordinary
   periods, so you can see if bad weeks were followed by recoveries or by
   more pain.
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)

PROFILES.TROY.leverage = Number(process.argv[2] ?? 1.8); PROFILES.TROY.exitAtClose = false
const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; execute(book, S, d, () => String(++n), {}); eq.push(markEquity(book, S, d, { btcDay: d - 1 })); if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n)) }

const DROP = -0.06
const events: { i: number; week: number; m1: number; m3: number; worstAfter: number; recovered: number }[] = []
for (let i = 5; i < eq.length - 63; i++) {
  const w = eq[i] / eq[i - 5] - 1
  if (w > DROP) continue
  if (events.length && i - events[events.length - 1].i < 5) continue
  const peak = Math.max(...eq.slice(i - 5, i + 1))
  let low = eq[i], rec = -1
  for (let k = i + 1; k <= i + 63; k++) { low = Math.min(low, eq[k]); if (rec < 0 && eq[k] >= peak) rec = k - i }
  events.push({ i, week: w, m1: eq[i + 21] / eq[i] - 1, m3: eq[i + 63] / eq[i] - 1, worstAfter: low / eq[i] - 1, recovered: rec })
}
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const all1: number[] = [], all3: number[] = []
for (let i = 0; i < eq.length - 63; i++) { all1.push(eq[i + 21] / eq[i] - 1); all3.push(eq[i + 63] / eq[i] - 1) }

console.log(`\nAFTER A BAD WEEK: TROY at ${PROFILES.TROY.leverage}x, ${iso(dates[START])} to ${iso(dates[N - 1])}. Weeks that lost ${(-DROP * 100).toFixed(0)}% or more: ${events.length} (about ${(events.length / ((N - START) / 252)).toFixed(1)} a year).\n`)
console.log(`${'week ending'.padEnd(13)}${'that week'.padStart(11)}${'next 1 mo'.padStart(11)}${'next 3 mo'.padStart(11)}${'worst after'.padStart(13)}${'back to the old high'.padStart(22)}`)
for (const e of events) console.log(`${iso(dates[START + e.i]).padEnd(13)}${pct(e.week).padStart(11)}${pct(e.m1).padStart(11)}${pct(e.m3).padStart(11)}${pct(e.worstAfter).padStart(13)}${(e.recovered > 0 ? `in ${e.recovered} trading days` : 'not within 3 months').padStart(22)}`)
const ev1 = events.map(e => e.m1), ev3 = events.map(e => e.m3)
console.log(`\nAfter bad weeks:   next month  avg ${pct(avg(ev1))}, median ${pct(med(ev1))}, up ${(100 * ev1.filter(x => x > 0).length / ev1.length).toFixed(0)}% of the time`)
console.log(`                   next 3 mo   avg ${pct(avg(ev3))}, median ${pct(med(ev3))}, up ${(100 * ev3.filter(x => x > 0).length / ev3.length).toFixed(0)}% of the time`)
console.log(`Any random day:    next month  avg ${pct(avg(all1))}, median ${pct(med(all1))}, up ${(100 * all1.filter(x => x > 0).length / all1.length).toFixed(0)}% of the time`)
console.log(`                   next 3 mo   avg ${pct(avg(all3))}, median ${pct(med(all3))}, up ${(100 * all3.filter(x => x > 0).length / all3.length).toFixed(0)}% of the time`)
console.log(`Back to the pre-drop high within 3 months: ${events.filter(e => e.recovered > 0).length} of ${events.length}. Kept falling more than another 10% before recovering: ${events.filter(e => e.worstAfter < -0.10).length} of ${events.length}.`)
let firstWeekBad = 0, starts = 0; for (let i = 0; i < eq.length - 5; i++) { starts++; if (eq[i + 5] / eq[i] - 1 <= -0.067) firstWeekBad++ }
console.log(`If you had started Troy on a random day, the first week would have lost 6.7%+ about ${(100 * firstWeekBad / starts).toFixed(0)}% of the time.\n`)
