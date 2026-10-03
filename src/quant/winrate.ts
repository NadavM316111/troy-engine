/* ═══════════════════════════════════════════════════════════════════════════
   WIN-RATE STUDY - can a swing strategy win 75%+ of trades AND make money?

     npm run q:winrate

   Dip-buying is where high win rates live: buy a sharp pullback inside an
   uptrend, sell into the first bounce. Quick exits raise the win rate but
   shrink the wins, so every variant is reported with what it earns, not just
   how often it wins. Same rules as the research: signal at the close, fill at
   the next open, 5bp per side, 10 equal slots, no stop loss (the dip edge is
   that stops get hit by the very dips you are buying).

   A variant earns its place only if: win rate >= 75%, positive expectancy
   after costs, and it holds in the last 30% of the data (OOS).
   ═══════════════════════════════════════════════════════════════════════════ */
import { loadDaily } from './daily.js'
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, type DSeries } from '../swing/core.js'

const COST = 0.0005
const raw = loadDaily()
const S: Record<string, DSeries & { sma50: Float64Array }> = {}
for (const [sym, bars] of Object.entries(raw)) {
  const s = buildSeries(bars.map(b => [b[0], b[1], b[2], b[3], b[4], b[1], b[4]])) as DSeries & { sma50: Float64Array }
  s.sma50 = new Float64Array(s.c.length).fill(NaN)
  let acc = 0; for (let i = 0; i < s.c.length; i++) { acc += s.c[i]; if (i >= 50) acc -= s.c[i - 50]; if (i >= 49) s.sma50[i] = acc / 50 }
  S[sym] = s
}
const U = STOCK_LIBRARY.map(x => x.sym).filter(x => S[x])
const dates = S['SPY'].days
const START = 210, SPLIT = START + Math.floor((dates.length - START) * 0.7)
const ok = (x: number) => Number.isFinite(x)

type Ser = typeof S[string]
interface V { name: string; entry: (s: Ser, i: number) => number | null; exit: (s: Ser, i: number, e: number, entryPx: number) => boolean; maxHold: number }
const up = (s: Ser, i: number) => s.c[i] > s.sma200[i]
const dip = (th: number) => (s: Ser, i: number) => up(s, i) && s.rsi2[i] < th ? -s.rsi2[i] : null
const VARIANTS: V[] = [
  { name: 'RSI2<5, exit > 5-day avg (current DIP leg)', entry: dip(5), exit: (s, i) => s.c[i] > s.sma5[i], maxHold: 10 },
  { name: 'RSI2<5, exit first up close', entry: dip(5), exit: (s, i) => s.c[i] > s.c[i - 1], maxHold: 10 },
  { name: 'RSI2<10, exit first up close', entry: dip(10), exit: (s, i) => s.c[i] > s.c[i - 1], maxHold: 10 },
  { name: 'RSI2<2, exit first up close', entry: dip(2), exit: (s, i) => s.c[i] > s.c[i - 1], maxHold: 10 },
  { name: 'RSI2<5, exit RSI2 > 50', entry: dip(5), exit: (s, i) => s.rsi2[i] > 50, maxHold: 10 },
  { name: 'RSI2<5, exit close > prior high', entry: dip(5), exit: (s, i) => s.c[i] > s.h[i - 1], maxHold: 10 },
  { name: 'RSI2<5, exit any close above entry', entry: dip(5), exit: (s, i, _e, px) => s.c[i] > px * (1 + 2 * COST), maxHold: 10 },
  { name: 'RSI2<5, exit any close above entry, 20d', entry: dip(5), exit: (s, i, _e, px) => s.c[i] > px * (1 + 2 * COST), maxHold: 20 },
  { name: 'RSI2<5 + 50>200 trend, exit > 5-day avg', entry: (s, i) => up(s, i) && s.sma50[i] > s.sma200[i] && s.rsi2[i] < 5 ? -s.rsi2[i] : null, exit: (s, i) => s.c[i] > s.sma5[i], maxHold: 10 },
  { name: 'RSI2<5 + 50>200 trend, exit first up close', entry: (s, i) => up(s, i) && s.sma50[i] > s.sma200[i] && s.rsi2[i] < 5 ? -s.rsi2[i] : null, exit: (s, i) => s.c[i] > s.c[i - 1], maxHold: 10 },
]

function run(v: V) {
  let cash = 1, equity = 1
  const pos: { sym: string; e: number; px: number; sh: number }[] = []
  const tr: { ret: number; net: number; e: number; hold: number }[] = []
  const eq: number[] = []
  let pX: typeof pos = [], pE: string[] = []
  const at = (s: Ser, d: number) => s.idx.get(d)
  const lastC = (s: Ser, d: number) => { const i = at(s, d); if (i !== undefined) return s.c[i]; for (let k = s.days.length - 1; k >= 0; k--) if (s.days[k] <= d) return s.c[k]; return NaN }
  for (let t = START; t < dates.length; t++) {
    const d = dates[t]
    for (const p of pX) { const s = S[p.sym]; const i = at(s, d); const f = i !== undefined ? s.o[i] : lastC(s, d); cash += p.sh * f * (1 - COST); pos.splice(pos.indexOf(p), 1); tr.push({ ret: f / p.px - 1, net: (f * (1 - COST)) / (p.px * (1 + COST)) - 1, e: p.e, hold: t - p.e }) }
    const slot = equity / 10
    for (const u of pE) { if (pos.length >= 10) break; const s = S[u]; const i = at(s, d); if (i === undefined) continue; const a = Math.min(cash, slot); if (a < slot * 0.5) break; pos.push({ sym: u, e: t, px: s.o[i], sh: a / (s.o[i] * (1 + COST)) }); cash -= a }
    pX = []; pE = []
    equity = cash + pos.reduce((a, p) => a + p.sh * lastC(S[p.sym], d), 0); eq.push(equity)
    if (t === dates.length - 1) break
    for (const p of pos) { const s = S[p.sym]; const i = at(s, d); if (i === undefined) continue; const e = at(s, dates[p.e])!; if (i - e + 1 >= v.maxHold || v.exit(s, i, e, p.px)) pX.push(p) }
    let free = Math.min(10 - pos.length + pX.length, Math.floor((cash + pX.reduce((a, p) => a + p.sh * lastC(S[p.sym], d), 0)) / slot + 1e-9))
    if (free <= 0) continue
    const held = new Set(pos.map(p => p.sym))
    const c: [string, number][] = []
    for (const u of U) { if (held.has(u)) continue; const s = S[u]; const i = at(s, d); if (i === undefined || !ok(s.sma200[i]) || !ok(s.rsi2[i])) continue; const sc = v.entry(s, i); if (sc !== null) c.push([u, sc]) }
    pE = c.sort((a, b) => b[1] - a[1]).slice(0, free).map(x => x[0])
  }
  const st = (x: typeof tr) => {
    const w = x.filter(q => q.ret > 0), l = x.filter(q => q.ret <= 0)
    const gw = x.filter(q => q.net > 0).reduce((a, q) => a + q.net, 0), gl = -x.filter(q => q.net <= 0).reduce((a, q) => a + q.net, 0)
    const m = (a: number[]) => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0
    return { n: x.length, win: 100 * w.length / Math.max(1, x.length), aw: 100 * m(w.map(q => q.ret)), al: 100 * m(l.map(q => q.ret)), exp: 1e4 * m(x.map(q => q.net)), pf: gl > 0 ? gw / gl : 0, hold: m(x.map(q => q.hold)) }
  }
  const r = eq.slice(1).map((x, i) => x / eq[i] - 1), mu = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, q) => a + (q - mu) ** 2, 0) / (r.length - 1))
  let pk = eq[0], mdd = 0; for (const x of eq) { pk = Math.max(pk, x); mdd = Math.max(mdd, 1 - x / pk) }
  return { all: st(tr), oos: st(tr.filter(q => q.e >= SPLIT)), cagr: 100 * (Math.pow(eq[eq.length - 1] / eq[0], 252 / (eq.length - 1)) - 1), sharpe: (mu / sd) * Math.sqrt(252), mdd: 100 * mdd }
}

console.log(`\nWIN-RATE STUDY: ${U.length} stocks, ${((dates.length - START) / 252).toFixed(1)} years, OOS = last 30%\n`)
const H = `${'variant'.padEnd(46)}${'trades'.padStart(7)}${'win%'.padStart(7)}${'OOS win'.padStart(8)}${'avgW%'.padStart(7)}${'avgL%'.padStart(7)}${'exp bp'.padStart(8)}${'OOS exp'.padStart(8)}${'PF'.padStart(6)}${'hold'.padStart(6)}${'CAGR'.padStart(8)}${'Sharpe'.padStart(7)}${'maxDD'.padStart(7)}  verdict`
console.log(H); console.log('-'.repeat(H.length))
const out: any[] = []
for (const v of VARIANTS) {
  const r = run(v)
  const pass = r.all.win >= 75 && r.all.exp > 0 && r.oos.win >= 75 && r.oos.exp > 0
  console.log(`${v.name.padEnd(46)}${String(r.all.n).padStart(7)}${r.all.win.toFixed(1).padStart(7)}${r.oos.win.toFixed(1).padStart(8)}${r.all.aw.toFixed(2).padStart(7)}${r.all.al.toFixed(2).padStart(7)}${r.all.exp.toFixed(1).padStart(8)}${r.oos.exp.toFixed(1).padStart(8)}${r.all.pf.toFixed(2).padStart(6)}${r.all.hold.toFixed(1).padStart(6)}${(r.cagr.toFixed(1) + '%').padStart(8)}${r.sharpe.toFixed(2).padStart(7)}${(r.mdd.toFixed(0) + '%').padStart(7)}  ${pass ? 'PASS 75%' : r.all.win >= 75 ? 'high win, check $' : '-'}`)
  out.push({ name: v.name, ...r, pass })
}
const passers = out.filter(x => x.pass).sort((a, b) => b.sharpe - a.sharpe)
console.log(`\n${passers.length ? `Best 75%+ variant: ${passers[0].name}, ${passers[0].all.win.toFixed(1)}% win (OOS ${passers[0].oos.win.toFixed(1)}%), ${passers[0].all.exp.toFixed(1)}bp per trade, CAGR ${passers[0].cagr.toFixed(1)}%, Sharpe ${passers[0].sharpe.toFixed(2)}, max DD ${passers[0].mdd.toFixed(0)}%.` : 'No variant reached 75% with positive expectancy in and out of sample.'}`)
console.log(`For comparison, the deployed combo book: 52.3% win, 27.3% CAGR, Sharpe 1.30. A 75% book trades win rate for growth unless its CAGR/Sharpe above say otherwise.\n`)
