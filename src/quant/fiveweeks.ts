/* ═══════════════════════════════════════════════════════════════════════════
   FIVEWEEKS - 5 separate random weeks, each run day by day with Troy's
   algorithm (1.6x + earnings drift 0.6x), real engine, all costs.

     npm run q:fiveweeks           (5 random weeks, at least a month apart)
     npm run q:fiveweeks -- 8      (a different number of weeks)

   Each week: a fresh $1,000,000 starting that Monday (decide at the close,
   fill at the next open, like Troy's live launch), plus how a book that had
   been running since 2017 did that same week.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries, type SwingTrade } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dow = (d: number) => new Date(d * 86400000).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ev: Record<string, number[]> = {}
for (const sym of U) { const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue; const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) { let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 960) d += 1; const k = s.days.findIndex(x => x >= d); if (k >= 1) ev[sym].push(s.days[k]) } }
setEarnings(ev)
const P = PROFILES.TROY; P.leverage = 1.6; P.exitAtClose = false; P.earnDrift = { jump: 0.03, hold: 20, weight: 0.6, slots: 10 }

/* pick the weeks */
const want = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) ?? 5)
const mondays: number[] = []; for (let t = START + 60; t < N - 7; t++) if (new Date(dates[t] * 86400000).getUTCDay() === 1) mondays.push(t)
const picked: number[] = []
for (let tries = 0; picked.length < want && tries < 10000; tries++) { const t = mondays[Math.floor(Math.random() * mondays.length)]; if (picked.every(p => Math.abs(p - t) >= 21)) picked.push(t) }
picked.sort((a, b) => a - b)

/* a book that has been running since 2017 (one pass) */
const wb = newBook(1, dates[START], 'TROY'); const warm = new Map<number, number>(); let n = 0
for (let t = START; t < N; t++) { const d = dates[t]; execute(wb, S, d, () => String(++n), {}); warm.set(t, markEquity(wb, S, d, { btcDay: d - 1 })); decide(wb, S, U, d, { btcDay: d - 1 }, () => String(++n)) }

const fmt = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}%`
const short = (f: SwingTrade) => `${f.action === 'BUY' ? '+' : '-'}${f.sym === 'BTC-USD' ? 'BTC' : f.sym}${f.leg === 'EARN' ? '(earn)' : f.leg === 'DIP' ? '(dip)' : ''}${f.action === 'SELL' && f.net !== undefined ? ` ${pct(f.net)}` : ''}`
const summary: { wk: string; spy: number; btc: number; fresh: number; run: number; trades: number }[] = []
const bt = S['BTC-USD']; const bclose = (d: number) => { for (let k = bt.days.length - 1; k >= 0; k--) if (bt.days[k] <= d - 1) return bt.c[k]; return NaN }
console.log(`\n${picked.length} RANDOM WEEKS with Troy (1.6x + earnings drift 0.6x), real engine, all costs.\n`)
for (const t0 of picked) {
  const week: number[] = []; for (let t = t0; t < N && week.length < 6; t++) week.push(t)
  const book = newBook(1_000_000, dates[t0], 'TROY'); let m = 0
  decide(book, S, U, dates[t0], { btcDay: dates[t0] - 1 }, () => String(++m))
  const spyR = S['SPY'].c[S['SPY'].idx.get(dates[week.at(-1)!])!] / S['SPY'].c[S['SPY'].idx.get(dates[t0])!] - 1
  const btcR = bclose(dates[week.at(-1)!]) / bclose(dates[t0]) - 1
  console.log(`WEEK OF ${iso(dates[week[1]])}   (SPY ${pct(spyR)}, Bitcoin ${pct(btcR)})`)
  let prev = 1_000_000, trades = 0
  for (const t of week.slice(1)) {
    const d = dates[t]; const fills = execute(book, S, d, () => String(++m), {}); trades += fills.length
    const v = markEquity(book, S, d, { btcDay: d - 1 })
    console.log(`  ${dow(d)} ${iso(d)}  ${fmt(v).padStart(11)}  ${pct(v / prev - 1).padStart(7)}  ${fills.length ? fills.map(short).join(' ') : ''}`)
    prev = v; decide(book, S, U, d, { btcDay: d - 1 }, () => String(++m))
  }
  const fresh = prev / 1_000_000 - 1, run = warm.get(week.at(-1)!)! / warm.get(t0)! - 1
  console.log(`  WEEK: fresh start ${pct(fresh)} (${fresh >= 0 ? '+' : '-'}${fmt(Math.abs(prev - 1_000_000))})   |   running book ${pct(run)}\n`)
  summary.push({ wk: iso(dates[week[1]]), spy: spyR, btc: btcR, fresh, run, trades })
}
console.log(`SUMMARY`)
console.log(`  ${'week of'.padEnd(12)}${'SPY'.padStart(9)}${'Bitcoin'.padStart(10)}${'Troy fresh'.padStart(12)}${'Troy running'.padStart(14)}${'trades'.padStart(8)}`)
for (const s of summary) console.log(`  ${s.wk.padEnd(12)}${pct(s.spy).padStart(9)}${pct(s.btc).padStart(10)}${pct(s.fresh).padStart(12)}${pct(s.run).padStart(14)}${String(s.trades).padStart(8)}`)
const avg = (k: 'spy' | 'fresh' | 'run') => summary.reduce((a, s) => a + s[k], 0) / summary.length
console.log(`  ${'average'.padEnd(12)}${pct(avg('spy')).padStart(9)}${''.padStart(10)}${pct(avg('fresh')).padStart(12)}${pct(avg('run')).padStart(14)}`)
console.log(`  Troy (running) beat SPY in ${summary.filter(s => s.run > s.spy).length} of ${summary.length} weeks. For reference, Troy's long-run average week is about +1.1%.\n`)
