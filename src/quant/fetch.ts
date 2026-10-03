/* npm run q:fetch   pulls ~30 days of 1-minute bars for Troy's whole universe. */
import { STOCK_LIBRARY, SAFE_STOCKS } from '../rules.js'
import { fetchSymbol, saveSymbol, DATA_DIR } from './data.js'

const extra = process.argv.slice(2).filter(a => !a.startsWith('-'))
const syms = [...new Set(['SPY', 'QQQ', ...SAFE_STOCKS, ...STOCK_LIBRARY.map(s => s.sym), ...extra])]
console.log(`Fetching ${syms.length} symbols into ${DATA_DIR}`)
let ok = 0
for (const s of syms) {
  const bars = await fetchSymbol(s)
  if (bars.length) { saveSymbol(s, bars); ok++ }
  console.log(`${s.padEnd(6)} ${bars.length ? `${bars.length} bars` : 'FAILED'}`)
}
console.log(`\nDone: ${ok}/${syms.length} symbols.`)
