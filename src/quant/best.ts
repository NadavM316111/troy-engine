/* ═══════════════════════════════════════════════════════════════════════════
   BEST - can Troy keep 70.6%+ a year with a higher Sharpe and a worst drop of
   35.5% or better? Real engine, one book, all costs, SEC earnings dates.

     npm run q:best              (needs q:earnings-fetch once, and ^VIX cached)

   Part 1  fine grid: Troy 1.50-1.75x x earnings drift 0.5-1.0x (20-day hold)
   Part 2  Tom's SS67 v1.2 Leverage Ladder (downside volatility, 6 tiers, per
           sleeve, calibrated on 2017-2021), alone and with earnings drift,
           at the sheet's tier values and scaled to 90%
   Part 3  the setups that pass all three: >= 70.6%/yr, drop <= 35.5%, Sharpe > 1.65

   Borrowing is charged at Troy's 5%/yr in every run so all rows compare
   with today's 70.6%. Ladder modelling notes: tiers act at the next open
   (no intraday shock fills), step-ups size new positions and Bitcoin to the
   new target but don't top up existing stocks, Hyper is auto-confirmed.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from 'node:fs'
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, setEarnings, type DSeries } from '../swing/core.js'

const raw = loadDaily()
const S: Record<string, DSeries> = {}
for (const [sym, bars] of Object.entries(raw)) S[sym] = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]]))
const U = STOCK_LIBRARY.map(s => s.sym).filter(s => S[s])
const dates = S['SPY'].days, N = dates.length, START = 260, SPLIT = START + Math.floor((N - START) * 0.7)
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const ok = (x: number) => Number.isFinite(x)
if (!S['^VIX']) console.log(`NOTE: no ^VIX data; the ladder's VIX rules are skipped. Run: npm run q:daily -- '^VIX'`)

/* earnings reaction days */
const ev: Record<string, number[]> = {}; let releases = 0
for (const sym of U) {
  const f = `quant/daily/earnings/${sym}.json`; if (!existsSync(f)) continue
  const s = S[sym]; ev[sym] = []
  for (const e of JSON.parse(readFileSync(f, 'utf8')).events as { date: string; accepted: string }[]) {
    let d = dayNum(e.date); const hh = +String(e.accepted).slice(11, 13), mm = +String(e.accepted).slice(14, 16); if (hh * 60 + mm >= 16 * 60) d += 1
    const k = s.days.findIndex(x => x >= d); if (k >= 1) { ev[sym].push(s.days[k]); releases++ }
  }
}
if (!releases) { console.log('No earnings data. Run: npm run q:earnings-fetch'); process.exit(0) }
setEarnings(ev)

/* ---------- SS67 v1.2 ladder ---------- */
type Tier = 'CRISIS' | 'CHOPPY_DOWN' | 'CHOPPY_UP' | 'NORMAL' | 'CALM' | 'HYPER'
const LEV: Record<Tier, number> = { CRISIS: 0.90, CHOPPY_DOWN: 1.30, CHOPPY_UP: 1.77, NORMAL: 1.77, CALM: 2.10, HYPER: 2.50 }
const lastIdx = (s: DSeries, d: number) => { for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= d) return k; return -1 }
const cl = (sym: string, d: number) => { const s = S[sym]; if (!s) return NaN; const k = lastIdx(s, d); return k >= 0 ? s.c[k] : NaN }
const sma = (sym: string, d: number, n: number) => { const s = S[sym]; const k = lastIdx(s, d); if (k < n) return NaN; let m = 0; for (let j = k - n + 1; j <= k; j++) m += s.c[j]; return m / n }
const hi = (sym: string, d: number, n: number) => { const s = S[sym]; const k = lastIdx(s, d); let m = -Infinity; for (let j = Math.max(0, k - n + 1); j <= k; j++) m = Math.max(m, s.c[j]); return m }
const ret = (sym: string, d: number, n: number) => { const s = S[sym]; const k = lastIdx(s, d); return k >= n ? s.c[k] / s.c[k - n] - 1 : NaN }
class Sleeve {
  ev = 0; prevExp = NaN; tier: Tier = 'NORMAL'; upStreak = 0; shockHold = 0; calmBandStreak = 0; hyperDays = 0; cooldown = 0
  days: Partial<Record<Tier, number>> = {}
  constructor(public cal: number[]) {}
  pct(v: number) { let lo = 0, hi2 = this.cal.length; while (lo < hi2) { const m = (lo + hi2) >> 1; if (this.cal[m] < v) lo = m + 1; else hi2 = m } return 100 * lo / this.cal.length }
  step(r: number, stress: boolean, rising: boolean, gates: (pct: number) => boolean) {
    const shock = ok(this.prevExp) && this.prevExp > 0 && r < -3 * this.prevExp
    const hyperLoss = ok(this.prevExp) && this.prevExp > 0 && r < -2 * this.prevExp
    const neg = Math.min(r, 0); this.ev = this.ev === 0 ? neg * neg : (1 - 2 / 21) * this.ev + (2 / 21) * neg * neg
    const dvol = Math.sqrt(this.ev * 252); this.prevExp = dvol / Math.sqrt(252)
    const p = this.pct(dvol)
    if (this.cooldown > 0) this.cooldown--
    const bandOf = (q: number, sh: number): Tier => q < 25 - sh ? 'CALM' : q < 70 - sh ? 'NORMAL' : q < 92 - sh ? (rising ? 'CHOPPY_UP' : 'CHOPPY_DOWN') : 'CRISIS'
    const band = bandOf(p, 0), buf = bandOf(p, 2)
    this.calmBandStreak = band === 'CALM' ? this.calmBandStreak + 1 : 0
    const done = () => { this.days[this.tier] = (this.days[this.tier] ?? 0) + 1 }
    if (shock) { this.tier = 'CRISIS'; this.shockHold = 2; this.upStreak = 0; return done() }
    if (this.shockHold > 0) { this.shockHold--; return done() }
    if (stress) { this.tier = 'CRISIS'; this.upStreak = 0; return done() }
    if (this.tier === 'HYPER') {
      this.hyperDays++
      if (!gates(p) || this.hyperDays >= 15 || hyperLoss) { this.tier = band; this.cooldown = 10; this.hyperDays = 0 }
      return done()
    }
    if (band === 'CALM' && gates(p)) { this.tier = 'HYPER'; this.hyperDays = 0; this.upStreak = 0; return done() }
    if (LEV[band] < LEV[this.tier]) { this.tier = band; this.upStreak = 0 }
    else if (LEV[buf] > LEV[this.tier]) { this.upStreak++; if (this.upStreak >= 2) { this.tier = buf; this.upStreak = 0 } }
    else { this.upStreak = 0; if (LEV[band] === LEV[this.tier]) this.tier = band }
    done()
  }
}

/* ---------- one engine run ---------- */
type Cfg = { L: number; drift: number; ladder: number }   // ladder = 0 (off) or the scale applied to the tier values
function run(c: Cfg, cal?: { stocks: number[]; btc: number[] }) {
  const P = PROFILES.TROY
  P.leverage = c.L; P.exitAtClose = false; P.borrowRate = 0.05
  P.earnDrift = c.drift > 0 ? { jump: 0.03, hold: 20, weight: c.drift, slots: 10 } : undefined
  P.levStocks = undefined; P.levBtc = undefined; P.trimBand = c.ladder ? 1.02 : undefined
  const st = c.ladder && cal ? new Sleeve(cal.stocks) : null, bt = c.ladder && cal ? new Sleeve(cal.btc) : null
  const book = newBook(1, dates[START], 'TROY'); const eq: number[] = []; const sR: number[] = [], bR: number[] = []; let n = 0, prevSV = 0
  for (let t = START; t < N; t++) {
    const d = dates[t]
    const fills = execute(book, S, d, () => String(++n), {})
    let flow = 0; for (const f of fills) if (f.leg !== 'BTC' && f.leg !== 'EARN') flow += f.action === 'BUY' ? -f.total : f.total
    const e = markEquity(book, S, d, { btcDay: d - 1 }); eq.push(e)
    const sv = book.positions.filter(p => p.leg !== 'EARN').reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0)
    const sr = prevSV > 0 ? (sv - prevSV + flow) / prevSV : (t > START ? cl('SPY', d) / cl('SPY', dates[t - 1]) - 1 : 0)
    const br = t > START ? cl('BTC-USD', d - 1) / cl('BTC-USD', dates[t - 1] - 1) - 1 : 0
    sR.push(sr); bR.push(ok(br) ? br : 0); prevSV = sv
    if (st && bt) {
      const vix = S['^VIX'] ? cl('^VIX', d) : NaN
      const spy = cl('SPY', d), btc = cl('BTC-USD', d - 1), athEq = Math.max(...eq)
      st.step(sr, (ok(vix) && vix >= 30) || (spy < 0.9 * hi('SPY', d, 252) && spy < sma('SPY', d, 50)), spy > sma('SPY', d, 50) && ret('SPY', d, 20) > 0,
        p => st.calmBandStreak >= 10 && p < 20 && spy > sma('SPY', d, 200) && (!ok(vix) || vix < 18) && e >= 0.9 * athEq && st.cooldown === 0)
      bt.step(ok(br) ? br : 0, btc < 0.65 * hi('BTC-USD', d - 1, 90) && btc < sma('BTC-USD', d - 1, 50), btc > sma('BTC-USD', d - 1, 50) && ret('BTC-USD', d - 1, 20) > 0,
        p => bt.calmBandStreak >= 10 && p < 20 && btc > sma('BTC-USD', d - 1, 200) && btc >= 0.9 * hi('BTC-USD', d - 1, 30) && e >= 0.9 * athEq && bt.cooldown === 0)
      P.levStocks = LEV[st.tier] * c.ladder; P.levBtc = LEV[bt.tier] * c.ladder
    }
    if (t < N - 1) decide(book, S, U, d, { btcDay: d - 1 }, () => String(++n))
  }
  P.leverage = 1.8; P.earnDrift = undefined; P.levStocks = undefined; P.levBtc = undefined; P.trimBand = undefined
  return { eq, sR, bR, st, bt }
}
function stats(eq: number[], a = 0, b = eq.length - 1) {
  const r: number[] = []; let pk = eq[a], m = 0; for (let t = a + 1; t <= b; t++) { r.push(eq[t] / eq[t - 1] - 1); pk = Math.max(pk, eq[t]); m = Math.max(m, 1 - eq[t] / pk) }
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (r.length - 1))
  return { cagr: 100 * (Math.pow(eq[b] / eq[a], 252 / (b - a)) - 1), day: 100 * (Math.pow(eq[b] / eq[a], 1 / (b - a)) - 1), vol: 100 * sd * Math.sqrt(252), sh: mu / sd * Math.sqrt(252), mdd: 100 * m, worstDay: 100 * Math.min(...r) }
}
const cut = SPLIT - START
type Row = { label: string; a: ReturnType<typeof stats>; i: ReturnType<typeof stats>; o: ReturnType<typeof stats>; tiers?: string }
const mk = (label: string, eq: number[], tiers?: string): Row => ({ label, a: stats(eq), i: stats(eq, 0, cut), o: stats(eq, cut), tiers })
const H = `${'setup'.padEnd(40)}${'per day'.padStart(9)}${'per year'.padStart(10)}${'volatility'.padStart(12)}${'Sharpe'.padStart(8)}${'IS Shp'.padStart(8)}${'OOS Shp'.padStart(9)}${'worst drop'.padStart(12)}${'worst day'.padStart(11)}`
const line = (x: Row) => console.log(`${x.label.padEnd(40)}${(x.a.day.toFixed(3) + '%').padStart(9)}${(x.a.cagr.toFixed(1) + '%').padStart(10)}${(x.a.vol.toFixed(1) + '%').padStart(12)}${x.a.sh.toFixed(2).padStart(8)}${x.i.sh.toFixed(2).padStart(8)}${x.o.sh.toFixed(2).padStart(9)}${('-' + x.a.mdd.toFixed(1) + '%').padStart(12)}${(x.a.worstDay.toFixed(1) + '%').padStart(11)}`)

console.log(`\nBEST: ${iso(dates[START])} to ${iso(dates[N - 1])}, real engine, all costs, borrowing 5%/yr. ${Object.keys(ev).length} stocks, ${releases} SEC earnings releases.`)
const A = run({ L: 1.8, drift: 0, ladder: 0 })
const today = mk('Troy today (1.8x)', A.eq)
/* calibrate the ladder's downside-volatility bands on 2017-2021 */
const calEnd = dates.findIndex(d => d >= Date.UTC(2022, 0, 1) / 86400000) - START
const dv = (rs: number[]) => { let v = 0; return rs.map((r, i) => { const q = Math.min(r, 0); v = i === 0 ? q * q : (1 - 2 / 21) * v + (2 / 21) * q * q; return Math.sqrt(v * 252) }) }
const cal = { stocks: dv(A.sR).slice(20, calEnd).sort((x, y) => x - y), btc: dv(A.bR).slice(20, calEnd).sort((x, y) => x - y) }

const all: Row[] = [today]
console.log(`\nPART 1: FINE GRID (no ladder)`); console.log(H); console.log('-'.repeat(H.length)); line(today)
for (const L of [1.5, 1.55, 1.6, 1.65, 1.7, 1.75]) for (const w of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) { const r = mk(`Troy ${L.toFixed(2)}x + drift ${w.toFixed(1)}x`, run({ L, drift: w, ladder: 0 }).eq); all.push(r); line(r) }

console.log(`\nPART 2: TOM'S SS67 v1.2 LADDER (tiers ${Object.entries(LEV).map(([k, v]) => `${k} ${v}x`).join(', ')})`); console.log(H); console.log('-'.repeat(H.length)); line(today)
const share = (sl: Sleeve) => { const tot = Object.values(sl.days).reduce((x, y) => x + (y ?? 0), 0); return Object.entries(sl.days).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `${k} ${(100 * (v ?? 0) / tot).toFixed(0)}%`).join(', ') }
for (const sc of [1.0, 0.9]) for (const w of [0, 0.3, 0.5, 0.7]) {
  const r = run({ L: 1.8, drift: w, ladder: sc }, cal)
  const row = mk(`ladder${sc === 1 ? '' : ` x${sc}`}${w ? ` + drift ${w}x` : ' alone'}`, r.eq, `stocks: ${share(r.st!)} | Bitcoin: ${share(r.bt!)}`)
  all.push(row); line(row)
}
const lad = all.find(x => x.label === 'ladder alone')
if (lad?.tiers) console.log(`Time in each tier (ladder alone): ${lad.tiers}`)

console.log(`\nPART 3: SETUPS THAT PASS ALL THREE (>= 70.6%/yr, worst drop <= 35.5%, Sharpe > 1.65)`); console.log(H); console.log('-'.repeat(H.length))
const pass = all.filter(x => x !== today && x.a.cagr >= today.a.cagr && x.a.mdd <= today.a.mdd + 0.05 && x.a.sh > today.a.sh).sort((a, b) => b.a.sh - a.a.sh)
if (pass.length) for (const x of pass) line(x); else console.log('  none pass all three')
const near = all.filter(x => x !== today && x.a.sh > today.a.sh && x.a.mdd <= today.a.mdd + 1.5).sort((a, b) => b.a.cagr - a.a.cagr).slice(0, 5)
console.log(`\nClosest (Sharpe above today, drop within 1.5 points of -35.5%, most return first):`); for (const x of near) line(x)
console.log('')
