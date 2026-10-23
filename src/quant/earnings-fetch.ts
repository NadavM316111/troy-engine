/* ═══════════════════════════════════════════════════════════════════════════
   EARNINGS-FETCH - official earnings-release dates from the SEC.

     npm run q:earnings-fetch

   For every stock in Troy's list it looks up the company on SEC EDGAR and
   collects every 8-K filed under item 2.02 ("Results of Operations"), which
   US companies must file when they release earnings. Saves the filing date
   and the exact acceptance time (to tell before-the-open from after-the-close)
   to quant/daily/earnings/<SYM>.json. Foreign companies (who file 6-K
   instead) and ETFs / crypto are skipped and listed.
   SEC asks for a contact in the User-Agent and max 10 requests a second.
   ═══════════════════════════════════════════════════════════════════════════ */
import { mkdirSync, writeFileSync } from 'node:fs'
import { STOCK_LIBRARY } from '../rules.js'

const UA = { 'User-Agent': 'TROY Capital research nadavminkowitz@gmail.com', 'Accept-Encoding': 'gzip, deflate' }
const OUT = 'quant/daily/earnings'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function get(url: string): Promise<any> { for (let k = 0; k < 4; k++) { const r = await fetch(url, { headers: UA }); if (r.ok) return r.json(); await sleep(1000 * (k + 1)) } throw new Error(`failed ${url}`) }

mkdirSync(OUT, { recursive: true })
const map: Record<string, number> = {}
for (const v of Object.values(await get('https://www.sec.gov/files/company_tickers.json')) as any[]) map[v.ticker] = v.cik_str
const skip = new Set(['SPY', 'QQQ', 'GLD', 'VTI', 'IWM', 'DIA', 'TLT', 'BTC-USD', 'ETH-USD'])
const done: string[] = [], missing: string[] = [], foreign: string[] = []
for (const { sym } of STOCK_LIBRARY) {
  if (skip.has(sym)) continue
  const cik = map[sym.replace('.', '-')]
  if (!cik) { missing.push(sym); continue }
  const pad = String(cik).padStart(10, '0')
  const sub = await get(`https://data.sec.gov/submissions/CIK${pad}.json`); await sleep(150)
  const pages = [sub.filings.recent]
  for (const f of sub.filings.files ?? []) { if (f.filingTo >= '2016-01-01') { pages.push(await get(`https://data.sec.gov/submissions/${f.name}`)); await sleep(150) } }
  const ev: { date: string; accepted: string }[] = []
  let sixK = 0
  for (const p of pages) for (let i = 0; i < p.form.length; i++) {
    if (p.form[i] === '6-K') sixK++
    if ((p.form[i] === '8-K' || p.form[i] === '8-K/A') && String(p.items[i] ?? '').split(',').includes('2.02') && p.filingDate[i] >= '2016-01-01') ev.push({ date: p.filingDate[i], accepted: p.acceptanceDateTime[i] })
  }
  if (!ev.length && sixK) { foreign.push(sym); continue }
  const uniq = [...new Map(ev.map(e => [e.date, e])).values()].sort((a, b) => a.date.localeCompare(b.date))
  writeFileSync(`${OUT}/${sym}.json`, JSON.stringify({ sym, cik, events: uniq }))
  done.push(`${sym}:${uniq.length}`)
  process.stdout.write(`${sym} ${uniq.length}  `)
}
console.log(`\n\nSaved ${done.length} stocks to ${OUT}.`)
if (foreign.length) console.log(`Foreign filers (6-K, no item 2.02, skipped): ${foreign.join(', ')}`)
if (missing.length) console.log(`Not found on EDGAR (skipped): ${missing.join(', ')}`)
