/* ═══════════════════════════════════════════════════════════════════════════
   LINES - Troy's live sell lines for what it holds, and today's buy signals.

     npm run q:lines
     npm run q:lines -- ACN:B PG:B ARM:D        (custom list, B = breakout, D = dip)

   Pulls live daily prices from Yahoo and applies Troy's exact rules
   (swing/core.ts). Read-only, nothing is traded. Prices during market hours
   are "if it closed right now"; Troy decides on the real close at 4:20pm ET.
   ═══════════════════════════════════════════════════════════════════════════ */
import { STOCK_LIBRARY } from '../rules.js'
import { buildSeries, entryScore, BTC_TREND_DAYS, type DSeries } from '../swing/core.js'
import { fetchLiveDaily } from '../swing/data.js'

const DEFAULT = ['MSFT:B', 'TXN:B', 'ABBV:B', 'PG:B', 'XOM:B', 'COST:B', 'CVX:B', 'ACN:B', 'IBM:B', 'NOW:B']
const args = process.argv.slice(2).filter(a => a.includes(':'))
const hold = (args.length ? args : DEFAULT).map(a => { const [s, t] = a.split(':'); return { sym: s.toUpperCase(), leg: t?.toUpperCase() === 'D' ? 'DIP' : 'BREAKOUT' } })

const S: Record<string, DSeries> = {}
async function get(sym: string) { if (S[sym]) return S[sym]; const d = await fetchLiveDaily(sym, '2y'); if (d?.bars.length) S[sym] = buildSeries(d.bars); return S[sym] }
const usd = (x: number) => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`

console.log(`\nTROY LINES (live prices, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET)\n`)
console.log(`${'holding'.padEnd(8)}${'type'.padEnd(10)}${'price now'.padStart(12)}${'sell line'.padStart(13)}${'cushion'.padStart(10)}   rule`)
for (const h of hold) {
  const s = await get(h.sym); if (!s) { console.log(`${h.sym.padEnd(8)}no data`); continue }
  const i = s.days.length - 1, px = s.fc[i]
  if (h.leg === 'BREAKOUT') {
    let lo = Infinity; for (let k = i - 10; k < i; k++) lo = Math.min(lo, s.l[k] * (s.fc[k] / s.c[k]))   // 10-day low in traded prices
    console.log(`${h.sym.padEnd(8)}${'breakout'.padEnd(10)}${usd(px).padStart(12)}${usd(lo).padStart(13)}${pct(px / lo - 1).padStart(10)}   sells if it closes below the 10-day low (or at day 60)`)
  } else {
    let m = 0; for (let k = i - 4; k <= i; k++) m += s.fc[k]; m /= 5
    console.log(`${h.sym.padEnd(8)}${'dip'.padEnd(10)}${usd(px).padStart(12)}${usd(m).padStart(13)}${pct(px / m - 1).padStart(10)}   sells if it closes ABOVE the 5-day average (or at day 10)`)
  }
}
const b = await get('BTC-USD')
if (b) { const i = b.days.length - 1; let m = 0; for (let k = i - BTC_TREND_DAYS + 1; k <= i; k++) m += b.fc[k]; m /= BTC_TREND_DAYS; console.log(`${'BTC'.padEnd(8)}${'trend'.padEnd(10)}${usd(b.fc[i]).padStart(12)}${usd(m).padStart(13)}${pct(b.fc[i] / m - 1).padStart(10)}   sells all if it closes below the ${BTC_TREND_DAYS}-day average`) }

console.log(`\nBuy signals if the market closed right now (Troy only buys if it has room):`)
const held = new Set(hold.map(h => h.sym)); const br: string[] = [], dp: string[] = []
for (const u of STOCK_LIBRARY.map(x => x.sym)) {
  if (held.has(u)) continue
  const s = await get(u); if (!s) continue
  const i = s.days.length - 1
  if (entryScore('BREAKOUT', s, i) !== null) br.push(`${u} (new 20-day high ${usd(s.fc[i])}, 20-day return ${pct(s.ret20[i])})`)
  if (entryScore('DIP', s, i) !== null) dp.push(`${u} (RSI(2) ${s.rsi2[i].toFixed(1)})`)
  await new Promise(r => setTimeout(r, 60))
}
console.log(`  breakouts: ${br.length ? br.join(', ') : 'none'}`)
console.log(`  dips:      ${dp.length ? dp.join(', ') : 'none'}\n`)
