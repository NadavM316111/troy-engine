/* ═══════════════════════════════════════════════════════════════════════════
   INDICATORS — ported verbatim from the browser engine.

   Nothing here has been changed except MIN_SLICE (see below). It is a straight
   move so that the server and the UI compute identical numbers from identical
   inputs. If you ever need to prove the port is faithful, diff this file first.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { VAP } from './types.js'

export const FRACTIONAL_DECIMALS = 5

/* $1, not $5. At a $50 budget the ALGO_X route sizes positions at roughly $2.92
   (sleeve 35 x per-name cap 8.3%), and a $5 floor rejected every one of them —
   so a $50 account could not trade at all in the mode it actually runs in.
   Fractional shares fill exact dollar amounts, so the floor was always
   arbitrary; it exists to stop dust positions, and $1 does that fine. */
export const MIN_SLICE = 1

export function floorToPrecision(x: number, dp: number) { const f = 10 ** dp; return Math.floor(x * f) / f }

export function ss42Slice(notional: number, price: number): { shares: number; filled: number } {
  if (price <= 0 || notional <= 0) return { shares: 0, filled: 0 }
  const shares = floorToPrecision(notional / price, FRACTIONAL_DECIMALS)
  const filled = shares * price
  if (filled < MIN_SLICE) return { shares: 0, filled: 0 }
  return { shares, filled }
}

export function fmtShares(n: number): string { return Number.isInteger(n) ? String(n) : (+n.toFixed(4)).toString() }

export function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = prices.length - period; i < prices.length; i++) { const d = prices[i] - prices[i - 1]; if (d > 0) gains += d; else losses += Math.abs(d) }
  const ag = gains / period, al = losses / period
  if (al === 0) return 100
  return 100 - (100 / (1 + ag / al))
}

export function calcEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0
  if (prices.length < period) return prices[prices.length - 1]
  const k = 2 / (period + 1)
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k)
  return ema
}

export function calcMomentum(prices: number[], period = 5): number {
  if (prices.length < period + 1) return 0
  const r = prices[prices.length - 1], o = prices[prices.length - 1 - period]
  return o > 0 ? ((r - o) / o) * 100 : 0
}

export function calcATR(prices: number[], period = 14): number {
  if (prices.length < 2) return (prices[0] ?? 0) * 0.01
  const trs: number[] = []
  for (let i = 1; i < prices.length; i++) trs.push(Math.abs(prices[i] - prices[i - 1]))
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length)
}

export function calcStdDev(vals: number[]): number {
  if (vals.length < 2) return 0
  const m = vals.reduce((a, b) => a + b, 0) / vals.length
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length)
}

export function vwapProxy(bars: number[]): number {
  return bars.length ? bars.reduce((a, b) => a + b, 0) / bars.length : 0
}

/* ── SS41 volume profile ── */
export interface VolumeProfile { poc: number; vah: number; val: number; hvns: number[]; lvns: number[] }

export function buildVolumeProfile(bars: number[]): VolumeProfile | null {
  if (bars.length < 10) return null
  const mn = Math.min(...bars), mx = Math.max(...bars), range = mx - mn
  if (range < 0.0001) return null
  const BINS = 20, binSize = range / BINS, counts = new Array(BINS).fill(0)
  for (const p of bars) counts[Math.min(BINS - 1, Math.floor((p - mn) / binSize))]++
  const pocIdx = counts.indexOf(Math.max(...counts)), poc = mn + (pocIdx + 0.5) * binSize
  let vLo = pocIdx, vHi = pocIdx, captured = counts[pocIdx]
  while (captured / bars.length < 0.70 && (vLo > 0 || vHi < BINS - 1)) {
    const aLo = vLo > 0 ? counts[vLo - 1] : 0, aHi = vHi < BINS - 1 ? counts[vHi + 1] : 0
    if (aLo >= aHi && vLo > 0) { vLo--; captured += counts[vLo] } else if (vHi < BINS - 1) { vHi++; captured += counts[vHi] } else break
  }
  const avg = bars.length / BINS, hvns: number[] = [], lvns: number[] = []
  for (let i = 1; i < BINS - 1; i++) {
    const price = mn + (i + 0.5) * binSize
    if (counts[i] > avg * 1.5 && counts[i] >= counts[i-1] && counts[i] >= counts[i+1]) hvns.push(price)
    if (counts[i] < avg * 0.5 && counts[i] <= counts[i-1] && counts[i] <= counts[i+1]) lvns.push(price)
  }
  return { poc, vah: mn + (vHi + 1) * binSize, val: mn + vLo * binSize, hvns, lvns }
}

export function ss41BreakQuality(bp: number, dir: 'UP' | 'DOWN', vp: VolumeProfile | null): 'A' | 'B' | 'SKIP' {
  if (!vp) return 'B'
  const z = Math.abs(vp.vah - vp.val) / 3
  if (dir === 'UP') {
    if (vp.hvns.some(h => h > bp && h - bp < z * 2)) return 'SKIP'
    if (vp.lvns.some(l => l > bp && l - bp < z * 1.5)) return 'A'
  } else {
    if (vp.hvns.some(h => h < bp && bp - h < z * 2)) return 'SKIP'
    if (vp.lvns.some(l => l < bp && bp - l < z * 1.5)) return 'A'
  }
  return 'B'
}

export function ss41Target(entry: number, dir: 'UP' | 'DOWN', vp: VolumeProfile | null): number | null {
  if (!vp) return null
  if (dir === 'UP') { const n = vp.hvns.filter(h => h > entry).sort((a, b) => a - b)[0]; return n ?? (vp.vah > entry ? vp.vah : null) }
  const n = vp.hvns.filter(h => h < entry).sort((a, b) => b - a)[0]
  return n ?? (vp.val < entry ? vp.val : null)
}

export function ss40ExpectedMove(bars: number[]): number {
  if (bars.length < 5) return bars[bars.length - 1] * 0.01
  const rets = bars.slice(1).map((p, i) => Math.log(p / bars[i]))
  const sd = calcStdDev(rets)
  return bars[bars.length - 1] * (sd * Math.sqrt(252 * 75)) * Math.sqrt(1 / 252)
}
