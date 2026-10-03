/* SWING DATA (live) - daily bars from Yahoo for the swing book.
   Returns, per symbol, the bars buildSeries() wants plus split events, so a
   split while a position is open does not look like a 75% crash. */

const UA = 'Mozilla/5.0 (compatible; TroySwing/1.0)'
export interface LiveDaily { bars: [number, number, number, number, number, number, number][]; splits: { day: number; ratio: number }[] }

export async function fetchLiveDaily(sym: string, range = '2y'): Promise<LiveDaily | null> {
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
      const bars: LiveDaily['bars'] = []
      const seen = new Set<number>()
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], a = adj[i]
        if (![o, h, l, c].every(x => typeof x === 'number' && x > 0)) continue
        const day = Math.floor((ts[i] + off) / 86400)
        if (seen.has(day)) continue; seen.add(day)
        const f = typeof a === 'number' && a > 0 ? a / c : 1
        bars.push([day, o * f, h * f, l * f, c * f, o, c])
      }
      const splits = Object.values(r?.events?.splits ?? {}).map((x: any) => ({ day: Math.floor((x.date + off) / 86400), ratio: x.numerator / x.denominator })).filter(x => x.ratio > 0)
      return { bars: bars.sort((a, b) => a[0] - b[0]), splits }
    } catch { continue }
  }
  return null
}
