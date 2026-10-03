/* ═══════════════════════════════════════════════════════════════════════════
   DAILY DATA - ~10 years of split- and dividend-adjusted daily bars.

   Cache: quant/daily/<SYM>.json   bars: [dayKey, open, high, low, close, volume]
   Prices are adjusted with Yahoo's adjclose, so splits and dividends do not
   show up as fake crashes or fake gains.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DAILY_DIR = join(process.cwd(), 'quant', 'daily')
export type DBar = [number, number, number, number, number, number]

const UA = 'Mozilla/5.0 (compatible; TroyQuant/1.0)'

export async function fetchDaily(sym: string, range = '10y'): Promise<DBar[]> {
  const ySym = sym.replace(/\./g, '-')
  for (const host of ['query1', 'query2']) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=${range}&interval=1d&events=div,splits`, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const j: any = await res.json()
      const r = j?.chart?.result?.[0]
      const ts: number[] = r?.timestamp ?? []
      const q = r?.indicators?.quote?.[0] ?? {}
      const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? []
      const off: number = r?.meta?.gmtoffset ?? -14400
      const out: DBar[] = []
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i], a = adj[i]
        if (![o, h, l, c].every(x => typeof x === 'number' && x > 0)) continue
        const f = typeof a === 'number' && a > 0 ? a / c : 1
        out.push([Math.floor((ts[i] + off) / 86400), o * f, h * f, l * f, c * f, typeof v === 'number' ? v : 0])
      }
      const seen = new Map<number, DBar>(); for (const b of out) seen.set(b[0], b)
      return [...seen.values()].sort((a, b) => a[0] - b[0])
    } catch { continue }
  }
  return []
}

export function saveDaily(sym: string, bars: DBar[]) {
  mkdirSync(DAILY_DIR, { recursive: true })
  writeFileSync(join(DAILY_DIR, `${sym}.json`), JSON.stringify({ sym, fetchedAt: Date.now(), bars }))
}

export function loadDaily(): Record<string, DBar[]> {
  if (!existsSync(DAILY_DIR)) throw new Error(`No daily data in ${DAILY_DIR}. Run: npm run q:daily`)
  const out: Record<string, DBar[]> = {}
  for (const f of readdirSync(DAILY_DIR)) {
    if (!f.endsWith('.json')) continue
    const j = JSON.parse(readFileSync(join(DAILY_DIR, f), 'utf8'))
    if (j?.bars?.length) out[j.sym] = j.bars
  }
  return out
}
