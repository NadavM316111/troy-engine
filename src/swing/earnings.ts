/* ═══════════════════════════════════════════════════════════════════════════
   EARNINGS (live) - official earnings-release dates from SEC EDGAR, for the
   EARN leg (earnings drift). Same source and same rules as the research
   (quant/earnings-fetch.ts + quant/earnfinal.ts):

   - every 8-K filed under item 2.02 ("Results of Operations") is a release
   - reaction day = the filing date if accepted before 4pm ET, else the next
     trading day
   - fetched once per trading day, right before the 4:20pm decision

   SEC asks for a contact in the User-Agent and at most 10 requests a second.
   A failed fetch never blocks the decision: the EARN leg just takes no new
   trades that day, and everything else runs as normal.
   ═══════════════════════════════════════════════════════════════════════════ */
const UA = { 'User-Agent': 'TROY Capital nadavminkowitz@gmail.com', 'Accept-Encoding': 'gzip, deflate' }
const SKIP = new Set(['SPY', 'QQQ', 'GLD', 'VTI', 'IWM', 'DIA', 'TLT', 'BTC-USD', 'ETH-USD'])
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000
const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10)

async function getJson(url: string): Promise<any> {
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null } catch { /* retry */ }
    await sleep(800 * (k + 1))
  }
  throw new Error(`SEC fetch failed: ${url}`)
}

/** filing date + acceptance time -> reaction day on the given trading calendar */
export function reactionDay(date: string, accepted: string, tradingDays: number[]): number | null {
  let d = dayNum(date)
  const hh = +String(accepted).slice(11, 13), mm = +String(accepted).slice(14, 16)
  if (hh * 60 + mm >= 16 * 60) d += 1
  const k = tradingDays.findIndex(x => x >= d)
  return k >= 0 ? tradingDays[k] : null
}

let cikMap: Record<string, number> | null = null
let cache: { day: number; since: number; m: Record<string, number[]>; releases: number; failed: string[] } | null = null

/** Reaction days per symbol for every release since `sinceDay`. Cached for the trading day. */
export async function loadLiveEarnings(symbols: string[], tradingDays: number[], today: number, sinceDay: number) {
  if (cache && cache.day === today && cache.since <= sinceDay) return cache
  if (!cikMap) {
    const j = await getJson('https://www.sec.gov/files/company_tickers.json')
    cikMap = {}; for (const v of Object.values(j ?? {}) as any[]) cikMap[v.ticker] = v.cik_str
  }
  const m: Record<string, number[]> = {}, failed: string[] = []; let releases = 0
  const sinceIso = iso(sinceDay)
  for (const sym of symbols) {
    if (SKIP.has(sym)) continue
    const cik = cikMap[sym.replace('.', '-')]; if (!cik) continue
    try {
      const sub = await getJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`); await sleep(150)
      const p = sub?.filings?.recent; if (!p) continue
      const days = new Set<number>()
      for (let i = 0; i < p.form.length; i++) {
        if ((p.form[i] !== '8-K' && p.form[i] !== '8-K/A') || p.filingDate[i] < sinceIso) continue
        if (!String(p.items[i] ?? '').split(',').includes('2.02')) continue
        const r = reactionDay(p.filingDate[i], p.acceptanceDateTime[i], tradingDays)
        if (r !== null) days.add(r)
      }
      if (days.size) { m[sym] = [...days].sort((a, b) => a - b); releases += days.size }
    } catch { failed.push(sym) }
  }
  cache = { day: today, since: sinceDay, m, releases, failed }
  return cache
}
