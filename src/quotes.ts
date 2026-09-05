/* ═══════════════════════════════════════════════════════════════════════════
   QUOTES — ported from the Next.js route, with one important change.

   The browser fetched quotes per user. The server fetches the UNION of every
   active user's tickers once per tick and hands the same map to each engine
   run. Two users no longer means two times the API calls, and — more usefully —
   both users now see the identical SPY print, so they cannot end up in
   different regimes on the same afternoon. That was a real bug in the browser
   version, not a theoretical one.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { MarketSession, Quote, VAP } from './types.js'

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? ''
const UA = 'Mozilla/5.0 (compatible; TroyEngine/1.0)'

export function getMarketSession(): { session: MarketSession; nextOpen: number } {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay(), time = et.getHours() * 100 + et.getMinutes()
  if (day === 0 || day === 6) {
    const d = new Date(et); d.setDate(d.getDate() + (day === 0 ? 1 : 2)); d.setHours(4, 0, 0, 0)
    return { session: 'closed', nextOpen: d.getTime() }
  }
  if (time >= 400  && time < 930)  return { session: 'premarket',  nextOpen: 0 }
  if (time >= 930  && time < 1600) return { session: 'regular',    nextOpen: 0 }
  if (time >= 1600 && time < 2000) return { session: 'afterhours', nextOpen: 0 }
  const d = new Date(et)
  if (time >= 2000) d.setDate(d.getDate() + 1)
  d.setHours(4, 0, 0, 0)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  return { session: 'closed', nextOpen: d.getTime() }
}

export function etMinutesNow(): number {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return et.getHours() * 60 + et.getMinutes()
}

export function etParts(ts: number): Date { return new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' })) }
export function tsEtDayKey(ts: number): number { const d = etParts(ts); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) }
export function etDayKey(): number { return tsEtDayKey(Date.now()) }
export function etDateISO(ts = Date.now()): string { const d = etParts(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
export function etDateLabel(ts = Date.now()): string { return new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }) }

/* Parse the 1-min volume series Yahoo already returns alongside meta. This is
   what makes SS62 score instead of passing blind. No extra request. */
function deriveVolumeMetrics(result: any): { rvol: number | null; vap: VAP | null; dollarVol: number | null } {
  try {
    const closes: (number|null)[] = result?.indicators?.quote?.[0]?.close ?? []
    const vols:   (number|null)[] = result?.indicators?.quote?.[0]?.volume ?? []
    const pairs: { p: number; v: number }[] = []
    for (let i = 0; i < Math.min(closes.length, vols.length); i++) {
      const p = closes[i], v = vols[i]
      if (typeof p === 'number' && typeof v === 'number' && p > 0 && v >= 0) pairs.push({ p, v })
    }
    if (pairs.length < 8) return { rvol: null, vap: null, dollarVol: null }
    const totalVol = pairs.reduce((s, x) => s + x.v, 0)
    const dollarVol = pairs.reduce((s, x) => s + x.v * x.p, 0)
    const avgPerMin = totalVol / pairs.length
    const recent = pairs.slice(-5)
    const recentPerMin = recent.reduce((s, x) => s + x.v, 0) / recent.length
    const rvol = avgPerMin > 0 ? +(recentPerMin / avgPerMin).toFixed(3) : null
    const prices = pairs.map(x => x.p)
    const lo = Math.min(...prices), hi = Math.max(...prices)
    let vap: VAP | null = null
    if (hi > lo) {
      const BINS = 20, size = (hi - lo) / BINS
      const bins = new Array(BINS).fill(0)
      for (const x of pairs) bins[Math.min(BINS - 1, Math.max(0, Math.floor((x.p - lo) / size)))] += x.v
      vap = { lo: +lo.toFixed(4), hi: +hi.toFixed(4), bins }
    }
    return { rvol, vap, dollarVol: Math.round(dollarVol) }
  } catch { return { rvol: null, vap: null, dollarVol: null } }
}

async function fetchYahoo(ticker: string): Promise<Quote | null> {
  const ySym = ticker.replace(/\./g, '-')
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=1d&interval=1m`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=1d&interval=1m`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const j: any = await res.json()
      const result = j?.chart?.result?.[0]
      const meta = result?.meta
      if (!meta?.regularMarketPrice) continue
      const price = meta.regularMarketPrice
      const prev = meta.chartPreviousClose ?? meta.previousClose ?? price
      const { rvol, vap, dollarVol } = deriveVolumeMetrics(result)
      return {
        price: +price.toFixed(2),
        changePct: +(prev > 0 ? ((price - prev) / prev) * 100 : 0).toFixed(2),
        high: +(meta.regularMarketDayHigh ?? price).toFixed(2),
        low: +(meta.regularMarketDayLow ?? price).toFixed(2),
        prevClose: +prev.toFixed(2), source: 'yahoo', rvol, vap, dollarVol,
      }
    } catch { continue }
  }
  return null
}

async function fetchFinnhub(ticker: string): Promise<Quote | null> {
  if (!FINNHUB_KEY) return null
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`)
    if (!res.ok) return null
    const d: any = await res.json()
    if (!d?.c) return null
    return { price: +(+d.c).toFixed(2), changePct: +(+(d.dp ?? 0)).toFixed(2), high: +(+(d.h ?? d.c)).toFixed(2), low: +(+(d.l ?? d.c)).toFixed(2), prevClose: +(+(d.pc ?? d.c)).toFixed(2), source: 'finnhub', rvol: null, vap: null, dollarVol: null }
  } catch { return null }
}

/* Yahoo first, always. Finnhub's quote endpoint carries no volume series, and
   without volume SS62 passes every signal unscored — which is the state the app
   was silently in. Finnhub is the fallback, not the primary. */
async function fetchOne(ticker: string): Promise<Quote | null> {
  const yh = await fetchYahoo(ticker); if (yh && yh.price > 0) return yh
  const fh = await fetchFinnhub(ticker); if (fh && fh.price > 0) return fh
  return null
}

export async function getQuotes(tickers: string[]): Promise<{ quotes: Record<string, Quote>; dataSource: string; failed: string[] }> {
  const results: Record<string, Quote> = {}
  const failed: string[] = []
  const CHUNK = 20
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK)
    await Promise.all(chunk.map(async t => {
      const q = await fetchOne(t)
      if (q) results[t] = q; else failed.push(t)
    }))
    if (i + CHUNK < tickers.length) await new Promise(r => setTimeout(r, 150))
  }
  const srcs: Record<string, number> = {}
  Object.values(results).forEach(q => { srcs[q.source] = (srcs[q.source] ?? 0) + 1 })
  const dataSource = Object.keys(results).length === 0 ? 'none' : (srcs.yahoo && srcs.finnhub) ? 'mixed' : (srcs.yahoo ? 'yahoo' : 'finnhub')
  return { quotes: results, dataSource, failed }
}

export function marketHalt(quotes: Record<string, Quote>): { halted: boolean; spyPct: number } {
  const spy = quotes['SPY']?.changePct ?? quotes['QQQ']?.changePct
  if (spy === undefined) return { halted: false, spyPct: 0 }
  return { halted: spy <= -0.8, spyPct: spy }
}
