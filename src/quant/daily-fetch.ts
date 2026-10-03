/* npm run q:daily   pulls ~10 years of adjusted daily bars for Troy's universe. */
import { STOCK_LIBRARY, SAFE_STOCKS } from '../rules.js'
import { fetchDaily, saveDaily, DAILY_DIR } from './daily.js'

const syms = [...new Set(['SPY', 'QQQ', ...SAFE_STOCKS, ...STOCK_LIBRARY.map(s => s.sym), ...process.argv.slice(2)])]
console.log(`Fetching daily history for ${syms.length} symbols into ${DAILY_DIR}`)
let ok = 0
for (const s of syms) {
  const bars = await fetchDaily(s)
  if (bars.length) { saveDaily(s, bars); ok++ }
  const yrs = bars.length ? ((bars[bars.length - 1][0] - bars[0][0]) / 365.25).toFixed(1) : '0'
  console.log(`${s.padEnd(6)} ${bars.length ? `${bars.length} days (${yrs}y)` : 'FAILED'}`)
  await new Promise(r => setTimeout(r, 150))
}
console.log(`\nDone: ${ok}/${syms.length} symbols.`)
