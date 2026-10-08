/* npm run q:sp500   current S&P 500 list (from Wikipedia) + 10 years of daily bars for each.
   Falls back to Troy's own 71-stock list if the page cannot be read. */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { STOCK_LIBRARY } from '../rules.js'
import { fetchDaily, saveDaily, DAILY_DIR } from './daily.js'

const EXTRA = ['ETH-USD', 'SOL-USD', 'UUP', 'FXE', 'FXY', 'TIP', 'SHY', 'EWJ', 'FXI', 'UNG', 'CPER', 'DBA']
let syms: string[] = []
/* Primary source: the maintained S&P 500 constituents CSV on GitHub (plain
   text, no scraping). Wikipedia is the backup. */
try {
  const csv = await (await fetch('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv')).text()
  syms = csv.split('\n').slice(1).map(l => l.split(',')[0].trim()).filter(x => /^[A-Z][A-Z.]{0,5}$/.test(x))
} catch {}
if (syms.length < 400) try {
  const html = await (await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', { headers: { 'User-Agent': 'TroyQuant/1.0 (research script)' } })).text()
  const at = html.indexOf('id="constituents"')
  if (at >= 0) { const table = html.slice(at, html.indexOf('</table>', at)); syms = []; for (const r of table.split('<tr').slice(2)) { const m = r.match(/<td[^>]*>\s*(?:<a[^>]*>)?\s*([A-Z][A-Z.]{0,5})\s*(?:<\/a>)?\s*<\/td>/); if (m) syms.push(m[1]) } }
} catch {}
if (syms.length < 400) { console.log(`Could not read the S&P 500 list (got ${syms.length}). Using Troy's 71 stocks instead.`); syms = STOCK_LIBRARY.map(s => s.sym) }
syms = [...new Set(syms)]
mkdirSync(join(process.cwd(), 'quant'), { recursive: true })
writeFileSync(join(process.cwd(), 'quant', 'sp500.json'), JSON.stringify(syms))
console.log(`S&P 500 list: ${syms.length} symbols. Fetching daily history for them + ${EXTRA.length} extra assets into ${DAILY_DIR}`)
let ok = 0, i = 0
for (const s of [...syms, ...EXTRA]) {
  const bars = await fetchDaily(s)
  if (bars.length) { saveDaily(s, bars); ok++ }
  if (++i % 50 === 0) console.log(`  ${i} done (${ok} ok)`)
  await new Promise(r => setTimeout(r, 120))
}
console.log(`Done: ${ok}/${syms.length + EXTRA.length}.`)
