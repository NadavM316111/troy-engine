/* ═══════════════════════════════════════════════════════════════════════════
   DATA - historical 1-minute bars, fetched once and cached on disk.

   Yahoo serves 1-minute bars for roughly the last 30 calendar days, at most
   8 days per request. We pull 7-day windows and stitch them. Regular session
   only, because the live engine reads Yahoo's regularMarketPrice, which does
   not move in premarket or afterhours. Research data has to match what the
   live engine actually sees, or every conclusion is about a different market.

   Cache: quant/data/<SYM>.json   bars: [tSec, open, high, low, close, volume]
   ═══════════════════════════════════════════════════════════════════════════ */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_DIR = join(process.cwd(), 'quant', 'data')
export type Bar = [number, number, number, number, number, number]  // t, o, h, l, c, v

const UA = 'Mozilla/5.0 (compatible; TroyQuant/1.0)'

async function fetchWindow(sym: string, p1: number, p2: number): Promise<Bar[]> {
  const ySym = sym.replace(/\./g, '-')
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?period1=${p1}&period2=${p2}&interval=1m&includePrePost=false`
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const j: any = await res.json()
      const r = j?.chart?.result?.[0]
      const ts: number[] = r?.timestamp ?? []
      const q = r?.indicators?.quote?.[0] ?? {}
      const out: Bar[] = []
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i]
        if ([o, h, l, c].every(x => typeof x === 'number' && x > 0)) out.push([ts[i], o, h, l, c, typeof v === 'number' ? v : 0])
      }
      return out
    } catch { continue }
  }
  return []
}

export async function fetchSymbol(sym: string, days = 29): Promise<Bar[]> {
  const now = Math.floor(Date.now() / 1000)
  const start = now - days * 86400
  const all = new Map<number, Bar>()
  for (let p1 = start; p1 < now; p1 += 7 * 86400) {
    const p2 = Math.min(now, p1 + 7 * 86400)
    for (const b of await fetchWindow(sym, p1, p2)) all.set(b[0], b)
    await new Promise(r => setTimeout(r, 120))
  }
  return [...all.values()].sort((a, b) => a[0] - b[0])
}

export function saveSymbol(sym: string, bars: Bar[]) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, `${sym}.json`), JSON.stringify({ sym, fetchedAt: Date.now(), bars }))
}

export function loadAll(): Record<string, Bar[]> {
  if (!existsSync(DATA_DIR)) throw new Error(`No data in ${DATA_DIR}. Run: npm run q:fetch`)
  const out: Record<string, Bar[]> = {}
  for (const f of readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue
    const j = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))
    if (j?.bars?.length) out[j.sym] = j.bars
  }
  return out
}

/* ── Eastern time without calling Intl two million times ──
   The ET offset only changes at DST boundaries, so cache it per UTC hour. */
const offCache = new Map<number, number>()
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
export function etOffsetSec(tSec: number): number {
  const hk = Math.floor(tSec / 3600)
  const hit = offCache.get(hk); if (hit !== undefined) return hit
  const p: Record<string, number> = {}
  for (const x of fmt.formatToParts(new Date(hk * 3600 * 1000))) if (x.type !== 'literal') p[x.type] = Number(x.value)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000
  const off = wall - hk * 3600
  offCache.set(hk, off)
  return off
}
/** Same day key as quotes.ts tsEtDayKey. */
export function etDay(tSec: number): number { return Math.floor((tSec + etOffsetSec(tSec)) / 86400) }
/** Minutes after ET midnight. */
export function etMin(tSec: number): number { return Math.floor((((tSec + etOffsetSec(tSec)) % 86400) + 86400) % 86400 / 60) }
/** UTC seconds for a given ET day key and ET minute. */
export function etToUtc(day: number, minute: number): number {
  const guess = day * 86400 + minute * 60
  return guess - etOffsetSec(guess + 5 * 3600)
}

/** Split one symbol's bars into regular-session days: day -> 390 slots (09:30..15:59), null where no trade printed. */
export function byDay(bars: Bar[]): Map<number, (Bar | null)[]> {
  const out = new Map<number, (Bar | null)[]>()
  for (const b of bars) {
    const m = etMin(b[0]) - 570
    if (m < 0 || m >= 390) continue
    const d = etDay(b[0])
    let a = out.get(d); if (!a) { a = new Array(390).fill(null); out.set(d, a) }
    a[m] = b
  }
  return out
}

/** Days present in SPY with at least 300 of 390 minutes. Everything keys off these. */
export function tradingDays(all: Record<string, Bar[]>): number[] {
  const spy = all['SPY']; if (!spy) throw new Error('SPY missing from data')
  return [...byDay(spy).entries()].filter(([, a]) => a.filter(Boolean).length >= 300).map(([d]) => d).sort((a, b) => a - b)
}
