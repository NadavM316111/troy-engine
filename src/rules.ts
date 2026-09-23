/* ═══════════════════════════════════════════════════════════════════════════
   RULES — every SS sheet, ported from the browser engine.

   The penny sleeve is deliberately absent: it was reverted out of the app
   before this port. The SS65 shadow drawdown rule is also absent — it is
   shadow-only by its own specification and belongs in the browser until §11
   of that sheet clears.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Position, Quote, Regime, SS39Ctx } from './types.js'
import {
  calcATR, calcEMA, calcMomentum, calcRSI,
  ss40ExpectedMove, ss41BreakQuality, ss41Target, vwapProxy, MIN_SLICE,
  type VolumeProfile,
} from './indicators.js'

/* ── Constants ── */
export const SAFE_STOCKS = ['SPY', 'QQQ', 'GLD', 'BRK.B', 'VTI']
export const MAX_CONCURRENT_NORMAL = 12
export const MAX_CONCURRENT_DEFENSIVE = 3
export const CLUSTER_MAX_POS = 3
export const CLUSTER_MAX_NOTIONAL_PCT = 0.40

export const DEAD_WEAK_MS = 30 * 60 * 1000
export const SYMBOL_COOLDOWN_MS = 30 * 60 * 1000

export const H4_MIN_EXTENSION_R = 1.5
export const H4_BREAK_BUFFER = 0.0005

export const SS51_NO_ENTRY_MIN = 15 * 60 + 45
export const SS51_FLATTEN_MIN  = 15 * 60 + 55
export const SS51_HARD_MIN     = 15 * 60 + 57
export const SS56_FLAT_ASSERT_MIN = 15 * 60 + 58

export const ZANGER_BASE_MIN_BARS   = 10
export const ZANGER_EXPANSION_MULT  = 1.6
export const ZANGER_FAIL_STOP_PCT   = 0.02
export const ZANGER_FAIL_FAST_MS    = 6 * 60 * 1000
export const ZANGER_PYRAMID_TRIGGER = 0.03
export const ZANGER_MAX_PYRAMIDS    = 2
export const ZANGER_MAX_CONCURRENT  = 6
export const ZANGER_PER_NAME_CAP_PCT = 22

export const BEAST_MAX_CONCURRENT   = 2
export const BEAST_PER_NAME_CAP_PCT = 100
export const BEAST_MAX_PYRAMIDS     = 5
export const BEAST_PYRAMID_TRIGGER  = 0.02
export const BEAST_RISK_BUDGET_PCT  = 0.60
export const BEAST_BASELINE_CONF    = 50

export const SS53_START_MIN            = 10 * 60 + 30
export const SS53_REEVAL_MIN           = 15
export const SS53_BEAST_UPGRADE_CUTOFF = 11 * 60
export const RG_FULLGREEN_SPY = 0.30, RG_FULLGREEN_BREADTH = 0.65
export const RG_SEMIGREEN_SPY = -0.10
export const RG_MIXEDRED_SPY  = -0.80
export const RG_FULLRED_BREADTH = 0.25
export const RG_FULLGREEN_DUALCONF = 5

/* FULL_GREEN relaxation. On a genuinely strong tape — SPY above +0.30% AND
   breadth at 65% or better — the entry bars ease by 5%. Applies to FULL_GREEN
   only, so it can never loosen anything on a red or mixed day. It touches the
   confidence bars and the SS62 volume threshold; it does not touch stops,
   exits, sizing, or any risk cap. */
export const RG_FULLGREEN_RELAX = 0.95

export const ROSTER_SIZE_BEAST = 2, ROSTER_SIZE_BEASTPLUS = 3
export const SWITCH_THRESH_FULLGREEN = 0.0025
export const SWITCH_THRESH_SEMIGREEN = 0.0022
export const SWITCH_THRESH_DOWNGRADE = 0.0020
export const SWITCH_BUDGET_BEAST = 2, SWITCH_BUDGET_BEASTPLUS = 3
export const SCRATCH_BAND = 0.0005
export const SCRATCH_MAX  = 2
export const SCRATCH_FREEZE_MS = 30 * 60 * 1000

export const SS54_MIN_SYMBOLS = 8
export const SS54_MIN_SECTORS = 3
export const SS54_EXCLUDE = ['SPY','QQQ','DIA','IWM','VTI']
export const SS54_SECTOR_RS_FLOOR = 0
export const SS54_SYMBOL_RS_FLOOR = 0.20

export const SS55_BENCH_PCT = 0.001
export const SS55_HOUR_MS   = 60 * 60 * 1000
export const SS55_EXTEND_MS = 30 * 60 * 1000
export const SS55_LIN_R2    = 0.50
export const SS55_LIN_MAXDD = 0.0015
export const SS55_LIN_MAXFLIP = 6

export const SS57_LEDGER_MAX = 40
export const SS57_REVIEW_MIN = 16 * 60 + 30
export const SS57_MASS_SESSIONS = 3
export const SS57_HANDICAP_SESSIONS = 3

export const SS61_W2_START = 12 * 60 + 30
export const SS61_W3_START = 15 * 60 + 0
export const SS61_W3_END   = 15 * 60 + 58

/* SS61 W2 (lunch) recalibrated. `ss61RvProxy` compares recent price ranges to
   the SESSION average, and that average is dominated by the open. Lunch ranges
   compress, so 1.17 was asking 1pm to be choppier than 9:30 — unreachable. It
   has no bypass either, so ORB and break-retest died on it too. 0.65 asks lunch
   to beat a normal lunch, which is what the sheet intended. */
export const SS61_W2_SIG = 1.30, SS61_W2_RV = 0.65
export const SS61_W3_SIG = 1.15, SS61_W3_RV = 1.10
export const SS61_A2_STRIKES = 2

export const SS62_THETA_ALGO  = 0.70, SS62_THETA_BEAST = 0.80
export const SS62_ADJ_ALGO    = 2,    SS62_ADJ_BEAST   = 1
export const SS62_RVOL_EDGE   = 0.85

/* Same baseline error, different measurement. RVOL here is recent per-minute
   volume vs the session average, not a trailing 20-day same-window average. A
   typical lunch runs about half the session rate, so the sheet's "1.20x a
   normal lunch" is roughly 0.60 in these units. Morning and close (EDGE) are
   measured against a baseline that already matches them, so 0.85 stands. */
export const SS62_RVOL_NOON   = 0.60, SS62_RVOL_NOON_BEAST = 0.68
export const SS62_WARMUP_MIN  = 30
export const SS62_LANE1_BUMP  = 0.08   // rescaled: 0.15 was ~18% of a 0.85 bar, would be 25% of 0.60
export const SS62_LANE1_AFTER = 2

export const SS58_BAND_LO = 0.004, SS58_BAND_HI = 0.006
export const SS58_ESC_CEIL = 0.0085
export const SS58_ESC_CLOCK_MS = 45 * 60 * 1000
export const SS58_REENTRY_MS = 15 * 60 * 1000
export const SS58_FASTGROW_PCT = 0.003
export const SS58_OVEREXT_PCT = 6.0

export const SS59_FLOOR_PCT = 0.0030
export const SS59_GRACE_MS  = 30 * 1000
export const SS59_HARD_PCT  = 0.0050

export const REPEAT_DROP_STRIKES = 2
export const REPEAT_DROP_CONF    = 78
export const SS59B_STRIKES = 3
export const SS59B_LOCK_MS = 120 * 60 * 1000
export const SS59B_WINDOW_BARS = 40

export const STOCK_LIBRARY = [
  { sym: 'AAPL',  name: 'Apple Inc.',            sector: 'Technology'   },
  { sym: 'NVDA',  name: 'NVIDIA Corp.',           sector: 'Semiconductor'},
  { sym: 'MSFT',  name: 'Microsoft Corp.',        sector: 'Technology'   },
  { sym: 'GOOGL', name: 'Alphabet Inc.',          sector: 'Technology'   },
  { sym: 'AMZN',  name: 'Amazon.com Inc.',        sector: 'Consumer'     },
  { sym: 'META',  name: 'Meta Platforms',         sector: 'Technology'   },
  { sym: 'TSLA',  name: 'Tesla Inc.',             sector: 'EV'           },
  { sym: 'SPY',   name: 'S&P 500 ETF',            sector: 'Index'        },
  { sym: 'QQQ',   name: 'Nasdaq 100 ETF',         sector: 'Index'        },
  { sym: 'BRK.B', name: 'Berkshire Hathaway',     sector: 'Finance'      },
  { sym: 'JPM',   name: 'JPMorgan Chase',         sector: 'Finance'      },
  { sym: 'V',     name: 'Visa Inc.',              sector: 'Finance'      },
  { sym: 'GLD',   name: 'Gold ETF',               sector: 'Commodity'    },
  { sym: 'AMD',   name: 'Advanced Micro Devices', sector: 'Semiconductor'},
  { sym: 'NFLX',  name: 'Netflix Inc.',           sector: 'Media'        },
  { sym: 'PLTR',  name: 'Palantir Technologies',  sector: 'AI'           },
  { sym: 'XOM',   name: 'Exxon Mobil',            sector: 'Energy'       },
  { sym: 'LMT',   name: 'Lockheed Martin',        sector: 'Defense'      },
  { sym: 'VRT',   name: 'Vertiv Holdings',        sector: 'AI Infra'     },
  { sym: 'SMCI',  name: 'Super Micro Computer',   sector: 'AI Infra'     },
  { sym: 'CEG',   name: 'Constellation Energy',   sector: 'Energy'       },
  { sym: 'CRWD',  name: 'CrowdStrike Holdings',   sector: 'Cybersecurity'},
  { sym: 'PANW',  name: 'Palo Alto Networks',     sector: 'Cybersecurity'},
  { sym: 'UBER',  name: 'Uber Technologies',      sector: 'Consumer'     },
  { sym: 'COIN',  name: 'Coinbase Global',        sector: 'Crypto'       },
  { sym: 'MSTR',  name: 'MicroStrategy',          sector: 'Crypto'       },
  { sym: 'RDDT',  name: 'Reddit Inc.',            sector: 'Technology'   },
  { sym: 'ARM',   name: 'Arm Holdings',           sector: 'Semiconductor'},
  { sym: 'HOOD',  name: 'Robinhood Markets',      sector: 'Finance'      },
  { sym: 'IONQ',  name: 'IonQ Inc.',              sector: 'Quantum'      },
  { sym: 'VTI',   name: 'Vanguard Total Market',  sector: 'Index'        },
  { sym: 'AVGO',  name: 'Broadcom Inc.',           sector: 'Semiconductor'},
  { sym: 'LLY',   name: 'Eli Lilly',               sector: 'Healthcare'   },
  { sym: 'WMT',   name: 'Walmart Inc.',            sector: 'Consumer'     },
  { sym: 'JNJ',   name: 'Johnson & Johnson',       sector: 'Healthcare'   },
  { sym: 'MA',    name: 'Mastercard Inc.',         sector: 'Finance'      },
  { sym: 'HD',    name: 'Home Depot',              sector: 'Consumer'     },
  { sym: 'PG',    name: 'Procter & Gamble',        sector: 'Consumer'     },
  { sym: 'COST',  name: 'Costco Wholesale',        sector: 'Consumer'     },
  { sym: 'ORCL',  name: 'Oracle Corp.',            sector: 'Technology'   },
  { sym: 'ABBV',  name: 'AbbVie Inc.',             sector: 'Healthcare'   },
  { sym: 'BAC',   name: 'Bank of America',         sector: 'Finance'      },
  { sym: 'KO',    name: 'Coca-Cola Co.',           sector: 'Consumer'     },
  { sym: 'CVX',   name: 'Chevron Corp.',           sector: 'Energy'       },
  { sym: 'MRK',   name: 'Merck & Co.',             sector: 'Healthcare'   },
  { sym: 'PEP',   name: 'PepsiCo Inc.',            sector: 'Consumer'     },
  { sym: 'ADBE',  name: 'Adobe Inc.',              sector: 'Technology'   },
  { sym: 'TMO',   name: 'Thermo Fisher',           sector: 'Healthcare'   },
  { sym: 'CSCO',  name: 'Cisco Systems',           sector: 'Technology'   },
  { sym: 'ACN',   name: 'Accenture plc',           sector: 'Technology'   },
  { sym: 'MCD',   name: "McDonald's Corp.",        sector: 'Consumer'     },
  { sym: 'ABT',   name: 'Abbott Laboratories',     sector: 'Healthcare'   },
  { sym: 'LIN',   name: 'Linde plc',               sector: 'Materials'    },
  { sym: 'GE',    name: 'GE Aerospace',            sector: 'Industrial'   },
  { sym: 'TXN',   name: 'Texas Instruments',       sector: 'Semiconductor'},
  { sym: 'DIS',   name: 'Walt Disney Co.',         sector: 'Media'        },
  { sym: 'INTC',  name: 'Intel Corp.',             sector: 'Semiconductor'},
  { sym: 'IBM',   name: 'IBM Corp.',               sector: 'Technology'   },
  { sym: 'QCOM',  name: 'Qualcomm Inc.',           sector: 'Semiconductor'},
  { sym: 'CAT',   name: 'Caterpillar Inc.',        sector: 'Industrial'   },
  { sym: 'NOW',   name: 'ServiceNow Inc.',         sector: 'Technology'   },
  { sym: 'ISRG',  name: 'Intuitive Surgical',      sector: 'Healthcare'   },
  { sym: 'GS',    name: 'Goldman Sachs',           sector: 'Finance'      },
  { sym: 'INTU',  name: 'Intuit Inc.',             sector: 'Technology'   },
  { sym: 'RTX',   name: 'RTX Corp.',               sector: 'Defense'      },
  { sym: 'HON',   name: 'Honeywell Intl.',         sector: 'Industrial'   },
  { sym: 'UNH',   name: 'UnitedHealth Group',      sector: 'Healthcare'   },
  { sym: 'AXP',   name: 'American Express',        sector: 'Finance'      },
  { sym: 'BKNG',  name: 'Booking Holdings',        sector: 'Consumer'     },
  { sym: 'BLK',   name: 'BlackRock Inc.',          sector: 'Finance'      },
  { sym: 'BA',    name: 'Boeing Co.',              sector: 'Defense'      },
]

export const REGIME_RANK: Record<Regime, number> = { FULL_RED: 0, MIXED_RED: 1, SEMI_GREEN: 2, FULL_GREEN: 3 }

export function sectorOf(sym: string): string {
  return STOCK_LIBRARY.find(x => x.sym === sym)?.sector || 'Other'
}

/* ── SS16 capital ── */
export function ss16MaxSpend(sleeve: number, deployed: number, cash: number, allocPct: number, openRisk: number, beast = false): number {
  const available = Math.max(0, sleeve * (beast ? 1.0 : 0.70) - deployed)
  if (available < MIN_SLICE) return 0
  const reserveFloor = beast ? 0 : sleeve * 0.30
  if (cash <= reserveFloor) return 0
  if (openRisk >= sleeve * (beast ? BEAST_RISK_BUDGET_PCT : 0.03)) return 0
  return Math.min(available, sleeve * (beast ? 1.0 : 0.25), sleeve * (allocPct / 100), Math.max(0, cash - reserveFloor), cash * (beast ? 0.99 : 0.92))
}

/* ── SS37 v1.2 exit ladder ── */
export interface SS37Result {
  action: 'STOP' | 'PARTIAL_BANK' | 'RUNNER_STOP' | 'HOLD'
  signal: string; reasoning: string; updatedStopLevel: number
  sellFraction: number; stage: 'S1' | 'S2' | 'S3' | 'S4' | null
}

export function ss37Tick(pos: Position, price: number): SS37Result {
  const entry = pos.avgPrice, peak = Math.max(pos.highWatermark, price)
  let stop = pos.stopLevel
  const hardStop = entry * 0.97
  if (price >= entry * 1.05) stop = Math.max(stop, entry)
  if (pos.partialDone)       stop = Math.max(stop, peak * 0.96)
  const effectiveStop = Math.max(hardStop, stop)
  if (!pos.partialDone && price >= entry * 1.06) {
    return { action: 'PARTIAL_BANK', signal: 'SS37_S3_BANK', reasoning: `SS37-S3: +${(((price-entry)/entry)*100).toFixed(2)}% >= +6%. Banking 1/3 @ $${price.toFixed(2)}.`, updatedStopLevel: Math.max(stop, entry), sellFraction: 1/3, stage: 'S3' }
  }
  if (price <= effectiveStop) {
    const isRunner = pos.partialDone && effectiveStop > hardStop
    const isBE = !pos.partialDone && effectiveStop >= entry && price <= entry
    const stage = isRunner ? 'S4' : isBE ? 'S2' : 'S1'
    return { action: isRunner ? 'RUNNER_STOP' : 'STOP', signal: isRunner ? 'SS37_S4_TRAIL' : isBE ? 'SS37_S2_BE' : 'SS37_S1_HARD', reasoning: `SS37-${stage}: Stop $${effectiveStop.toFixed(2)} @ $${price.toFixed(2)} (${((price-entry)/entry*100).toFixed(2)}%).${isRunner ? ` Peak $${peak.toFixed(2)}.` : ''}`, updatedStopLevel: effectiveStop, sellFraction: 1.0, stage: stage as any }
  }
  return { action: 'HOLD', signal: 'SS37_HOLD', reasoning: `Stop $${effectiveStop.toFixed(2)}. Peak $${peak.toFixed(2)}.`, updatedStopLevel: stop, sellFraction: 0, stage: null }
}

export function ss50H4TopExit(pos: Position, price: number): { exit: boolean; reason: string } {
  if (!pos.partialDone) return { exit: false, reason: '' }
  const entry = pos.avgPrice
  const R = Math.max(entry * 0.03, 0.01)
  if (pos.highWatermark - entry < H4_MIN_EXTENSION_R * R) return { exit: false, reason: '' }
  const ref = pos.preTrailLow ?? entry
  if (price < ref - ref * H4_BREAK_BUFFER && price < pos.highWatermark) {
    return { exit: true, reason: `SS50-H4 CTE_T1: peak $${pos.highWatermark.toFixed(2)} rejected, broke pre-peak low $${ref.toFixed(2)} — banking runner near the high.` }
  }
  return { exit: false, reason: '' }
}

/* ── SS58 Beast sell-line band ── */
export function ss58FastGrow(bars: number[]): boolean {
  const w = bars.slice(-8); if (w.length < 5) return false
  const net = (w[w.length-1] - w[0]) / w[0]
  if (net < SS58_FASTGROW_PCT) return false
  const last = w.slice(-6); let greens = 0
  for (let i=1;i<last.length;i++) if (last[i] > last[i-1]) greens++
  return greens >= 3
}

export function ss58BandLine(entry: number, atr: number): number {
  const raw = atr > 0 && entry > 0 ? atr/entry : SS58_BAND_LO
  return entry * (1 + Math.min(SS58_BAND_HI, Math.max(SS58_BAND_LO, raw)))
}

export function ss58Tick(pos: Position, price: number, changePct: number, bars: number[], atr: number) {
  const entry = pos.avgPrice
  const bandLine = pos.bandLine ?? ss58BandLine(entry, atr)
  let sellLine = pos.sellLine ?? bandLine
  let escalated = pos.escalated ?? false
  let escUsed = pos.escUsed ?? false
  let escDeadline = pos.escDeadline ?? 0
  const escLine = entry * (1 + SS58_ESC_CEIL)
  if (changePct > SS58_OVEREXT_PCT) { escalated = false; sellLine = bandLine }
  else {
    if (!escUsed && ss58FastGrow(bars)) { sellLine = escLine; escalated = true; escUsed = true; escDeadline = Date.now() + SS58_ESC_CLOCK_MS }
    if (escalated && Date.now() > escDeadline && price < escLine) { escalated = false; sellLine = bandLine }
  }
  let sell = false, gEarned = false, reason = ''
  if (price >= sellLine) {
    sell = true
    if (escalated && price >= escLine && Date.now() <= escDeadline) { gEarned = true; reason = `SS58 G-Stock: escalated line +0.85% printed ($${sellLine.toFixed(2)}). Banked; symbol earns cooldown exemption.` }
    else reason = `SS58 band profit-take: +${(((price-entry)/entry)*100).toFixed(2)}% line printed ($${sellLine.toFixed(2)}). Banking the move.`
  }
  return { bandLine, sellLine, escalated, escUsed, escDeadline, sell, gEarned, reason }
}

export function ss59DownOnly(bars: number[]): boolean {
  const w = bars.slice(-SS59B_WINDOW_BARS); if (w.length < 8) return false
  if (w[w.length-1] >= w[0]) return false
  let hiIdx = 0; for (let i=1;i<w.length;i++) if (w[i] > w[hiIdx]) hiIdx = i
  if (hiIdx > Math.floor(w.length/3)) return false
  let consecUp = 0
  for (let i=1;i<w.length;i++) { if (w[i] > w[i-1]) { consecUp++; if (consecUp >= 2) return false } else consecUp = 0 }
  return true
}

/* ── SS61 intraday windows ── */
export type IntradayWindow = 'PRE' | 'W1' | 'W2' | 'W3' | 'FLAT'

export function ss61Window(etMin: number): IntradayWindow {
  if (etMin < SS53_START_MIN) return 'PRE'
  if (etMin < SS61_W2_START) return 'W1'
  if (etMin < SS61_W3_START) return 'W2'
  if (etMin < SS61_W3_END)   return 'W3'
  return 'FLAT'
}

export function ss61Mults(w: IntradayWindow): { sig: number; rv: number } {
  if (w === 'W2') return { sig: SS61_W2_SIG, rv: SS61_W2_RV }
  if (w === 'W3') return { sig: SS61_W3_SIG, rv: SS61_W3_RV }
  return { sig: 1.0, rv: 0 }
}

export function ss61RvProxy(bars: number[]): number | null {
  if (bars.length < 14) return null
  const ranges: number[] = []
  for (let i = 1; i < bars.length; i++) ranges.push(Math.abs(bars[i] - bars[i-1]))
  const recent = ranges.slice(-5)
  const rAvg = recent.reduce((a,b)=>a+b,0) / recent.length
  const aAvg = ranges.reduce((a,b)=>a+b,0) / ranges.length
  if (aAvg <= 0) return null
  return rAvg / aAvg
}

/* ── SS62 volume-confirmed entry gate ──
   `relax` is the FULL_GREEN easing factor (1 everywhere else). It scales the
   RVOL threshold only; the volume-at-price test is untouched. */
export function ss62Gate(q: Quote, price: number, win: IntradayWindow, beast: boolean, etMin: number, bump: number, relax = 1): { pass: boolean; reason: string } {
  const thr = ((win === 'W2' ? (beast ? SS62_RVOL_NOON_BEAST : SS62_RVOL_NOON) : SS62_RVOL_EDGE) + bump) * relax
  if (q.rvol != null && q.rvol < thr) return { pass: false, reason: `RVOL_LOW ${q.rvol.toFixed(2)}<${thr.toFixed(2)}` }
  if (etMin >= SS53_START_MIN + SS62_WARMUP_MIN && q.vap && q.vap.bins.length) {
    const { lo, hi, bins } = q.vap
    let peak = 0; for (const b of bins) if (b > peak) peak = b
    if (peak > 0 && hi > lo) {
      const size = (hi - lo) / bins.length
      const idx = Math.min(bins.length - 1, Math.max(0, Math.floor((price - lo) / size)))
      const theta = beast ? SS62_THETA_BEAST : SS62_THETA_ALGO
      const adj   = beast ? SS62_ADJ_BEAST   : SS62_ADJ_ALGO
      let ok = false
      for (let d = -adj; d <= adj && !ok; d++) { const i = idx + d; if (i >= 0 && i < bins.length && bins[i] >= theta * peak) ok = true }
      if (!ok) return { pass: false, reason: 'LVN_PRICE' }
    }
  }
  return { pass: true, reason: '' }
}

/* ── SS54 universe protection ── */
export function ss54UniverseDefect(quotes: Record<string, Quote>): boolean {
  const cand = Object.keys(quotes).filter(s => !SS54_EXCLUDE.includes(s) && (quotes[s]?.price ?? 0) > 0)
  if (cand.length < SS54_MIN_SYMBOLS) return true
  const sectors = new Set(cand.map(sectorOf))
  return sectors.size < SS54_MIN_SECTORS
}

export function ss54SectorGreen(sector: string, quotes: Record<string, Quote>, spyChange: number): boolean {
  const peers = STOCK_LIBRARY.filter(x => x.sector === sector).map(x => x.sym).filter(s => (quotes[s]?.price ?? 0) > 0)
  if (!peers.length) return true
  const sectorRet = peers.reduce((a, s) => a + (quotes[s]?.changePct ?? 0), 0) / peers.length
  return (sectorRet - spyChange) >= SS54_SECTOR_RS_FLOOR
}

/* ── SS55 linear-climb extension ── */
export function ss55Linear(bars: number[]): boolean {
  const w = bars.slice(-12); if (w.length < 5) return false
  const n = w.length; let sx=0, sy=0, sxx=0, sxy=0
  for (let i=0;i<n;i++){ sx+=i; sy+=w[i]; sxx+=i*i; sxy+=i*w[i] }
  const denom = n*sxx - sx*sx; if (denom === 0) return false
  const slope = (n*sxy - sx*sy) / denom
  if (slope <= 0) return false
  const mean = sy/n, intercept = (sy - slope*sx)/n
  let ssTot=0, ssRes=0
  for (let i=0;i<n;i++){ const pred = slope*i + intercept; ssRes += (w[i]-pred)**2; ssTot += (w[i]-mean)**2 }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes/ssTot
  if (r2 < SS55_LIN_R2) return false
  let hi = w[0], maxDD = 0
  for (const p of w){ hi = Math.max(hi, p); maxDD = Math.max(maxDD, (hi - p)/hi) }
  if (maxDD > SS55_LIN_MAXDD) return false
  let flips = 0
  for (let i=2;i<n;i++){ const a = w[i-1]-w[i-2], b = w[i]-w[i-1]; if ((a>0&&b<0)||(a<0&&b>0)) flips++ }
  return flips <= SS55_LIN_MAXFLIP
}

/* ── SS38 opening-range break ── */
export interface ORBState { orHigh: number; orLow: number; attempts: number }

export function buildORB(bars: number[]): ORBState | null {
  const K = Math.max(4, Math.floor(bars.length * 0.15))
  if (bars.length < K + 3) return null
  const w = bars.slice(0, K)
  return { orHigh: Math.max(...w), orLow: Math.min(...w), attempts: 0 }
}

export function ss38Signal(bars: number[], price: number, atr: number, vp: VolumeProfile | null, orb: ORBState | null) {
  if (!orb || orb.attempts >= 2 || bars.length < 6) return null
  const p2 = bars[bars.length - 2], p3 = bars.length > 2 ? bars[bars.length - 3] : p2
  if (p2 > orb.orHigh && p3 <= orb.orHigh) {
    const bq = ss41BreakQuality(price, 'UP', vp); if (bq === 'SKIP') return null
    const stop = Math.max(orb.orLow, price - 0.75 * atr)
    const r = price - stop, rTarget = price + 1.5 * r
    const s41t = ss41Target(price, 'UP', vp), em = price + ss40ExpectedMove(bars)
    const target = Math.max(rTarget, s41t ? Math.min(s41t, em) : em)
    return { buy: true, stop, target, reason: `SS38 ORB up-break (${p2.toFixed(2)} > OR_high ${orb.orHigh.toFixed(2)}), q=${bq}, tgt 1.5R`, grade: bq }
  }
  return null
}

/* ── SS39 break-retest ── */
export function detectBox(bars: number[]): { top: number; bot: number } | null {
  if (bars.length < 14) return null
  const w = bars.slice(-24), hi = Math.max(...w), lo = Math.min(...w), mid = (hi + lo) / 2, tol = (hi - lo) * 0.38
  if (w.filter(p => Math.abs(p - mid) <= tol / 2).length / w.length < 0.58) return null
  return { top: mid + tol / 2, bot: mid - tol / 2 }
}

export function ss39Step(bars: number[], ctx: SS39Ctx, atr: number, vp: VolumeProfile | null) {
  const NO = (c: SS39Ctx) => ({ entry: false, newCtx: c, stop: 0, target: 0, reason: '' })
  const price = bars[bars.length - 1], T = 0.25 * atr
  if (ctx.state === 'WAIT_BREAK') {
    const box = detectBox(bars); if (!box) return NO(ctx)
    const prev = bars[bars.length - 2], prev2 = bars.length > 2 ? bars[bars.length - 3] : prev
    if (prev > box.top && prev2 <= box.top) {
      if (ss41BreakQuality(price, 'UP', vp) === 'SKIP') return NO(ctx)
      return NO({ state: 'WAIT_RETEST', level: box.top, side: 'LONG', barsSince: 0, retestLow: price, retestHigh: price })
    }
    return NO(ctx)
  }
  if (ctx.state === 'WAIT_RETEST') {
    const nc: SS39Ctx = { ...ctx, barsSince: ctx.barsSince + 1, retestLow: Math.min(ctx.retestLow, price), retestHigh: Math.max(ctx.retestHigh, price) }
    if (nc.barsSince > 8) return NO({ ...nc, state: 'EXPIRED' })
    if (ctx.side === 'LONG' && price < ctx.level - T) return NO({ ...nc, state: 'FAILED' })
    if (ctx.side === 'LONG' && price <= ctx.level + T && price >= ctx.level - T) return NO({ ...nc, state: 'WAIT_CONFIRM' })
    return NO(nc)
  }
  if (ctx.state === 'WAIT_CONFIRM') {
    const prev = bars[bars.length - 2]
    if (ctx.side === 'LONG' && prev > ctx.level && price > ctx.level) {
      const stop = Math.max(ctx.retestLow - atr * 0.1, price * 0.97)
      const r = price - stop, rTarget = price + 1.5 * r
      const s41t = ss41Target(price, 'UP', vp), em = price + ss40ExpectedMove(bars)
      const target = Math.max(rTarget, s41t ? Math.min(s41t, em) : em)
      return { entry: true, newCtx: { ...ctx, state: 'WAIT_BREAK' as const }, stop, target, reason: `SS39 break-retest: broke ${ctx.level.toFixed(2)}, retested, confirmed @ ${prev.toFixed(2)}` }
    }
    if (ctx.side === 'LONG' && price < ctx.level - T) return NO({ ...ctx, state: 'FAILED' })
    return NO(ctx)
  }
  return NO({ state: 'WAIT_BREAK', level: 0, side: null, barsSince: 0, retestLow: price, retestHigh: price })
}

/* ── SS52 Zanger breakout ── */
export function ss52ZangerBreakout(bars: number[], price: number) {
  if (bars.length < ZANGER_BASE_MIN_BARS + 3) return null
  const base = bars.slice(0, -2)
  const pivot = Math.max(...base)
  const prev = bars[bars.length - 2], prev2 = bars[bars.length - 3]
  if (!(prev > pivot && prev2 <= pivot)) return null
  const recentRanges: number[] = []
  for (let i = Math.max(1, bars.length - 12); i < bars.length; i++) recentRanges.push(Math.abs(bars[i] - bars[i - 1]))
  const priorRanges = recentRanges.slice(0, -1)
  const avgRange = priorRanges.length ? priorRanges.reduce((a, b) => a + b, 0) / priorRanges.length : 0
  const breakRange = Math.abs(price - prev2)
  if (avgRange > 0 && breakRange < avgRange * ZANGER_EXPANSION_MULT) return null
  const grade: 'A'|'B' = (avgRange > 0 && breakRange >= avgRange * ZANGER_EXPANSION_MULT * 1.4) ? 'A' : 'B'
  const stop = Math.max(pivot * 0.999, price * (1 - ZANGER_FAIL_STOP_PCT))
  const thrust = avgRange > 0 ? (breakRange / avgRange) : ZANGER_EXPANSION_MULT
  return { buy: true, pivot, stop, reason: `SS52 Zanger breakout: cleared base pivot $${pivot.toFixed(2)} on ${thrust.toFixed(1)}x range thrust, grade ${grade}.`, grade }
}

export function ss52SwitchTrigger(pos: Position, price: number, vwap: number, spyChange: number, changePct: number, threshold: number): boolean {
  const dropPct = pos.avgPrice > 0 ? (pos.avgPrice - price) / pos.avgPrice : 0
  if (dropPct <= threshold) return false
  if (price >= vwap) return false
  if (changePct - spyChange >= 0) return false
  if (spyChange <= -threshold * 100) return false
  return true
}

/* ── SS53 regime classification ── */
export function classifyRegime(spyChange: number, greenFrac: number, _dualConf: number): Regime {
  if (spyChange < RG_MIXEDRED_SPY && greenFrac <= RG_FULLRED_BREADTH) return 'FULL_RED'
  if (spyChange >= RG_FULLGREEN_SPY && greenFrac >= RG_FULLGREEN_BREADTH) return 'FULL_GREEN'
  if (spyChange >= RG_SEMIGREEN_SPY) return 'SEMI_GREEN'
  if (spyChange >= RG_MIXEDRED_SPY) return 'MIXED_RED'
  return 'FULL_RED'
}

/* ── Baseline entry ── */
export interface EntrySignal { action: 'BUY' | 'HOLD'; confidence: number; signal: string; reasoning: string; allocPct: number; urgency: 'NORMAL' | 'LOW' }

export function troyBaseline(bars: number[], cashPct: number, targetPct: number, returnPct: number, session: string, isSafe = false): EntrySignal {
  const HOLD: EntrySignal = { action: 'HOLD', confidence: 0, signal: 'NO_SIGNAL', reasoning: 'No signal.', allocPct: 0, urgency: 'LOW' }
  if (bars.length < 4) return { ...HOLD, signal: 'INSUFFICIENT_DATA' }
  if (cashPct <= 12) return { ...HOLD, signal: 'LOW_CASH' }
  const rsi = calcRSI(bars, Math.min(14, bars.length - 1))
  const ema5 = calcEMA(bars, Math.min(5, bars.length)), ema20 = calcEMA(bars, Math.min(20, bars.length))
  const mom = calcMomentum(bars, Math.min(5, bars.length - 1))
  const vol = bars.length >= 2 && bars[bars.length-2] > 0 ? Math.abs(bars[bars.length-1]-bars[bars.length-2])/bars[bars.length-2]*100 : 0
  const gap = targetPct - returnPct
  const agg = isSafe ? 0.5 : Math.min(2.0, Math.max(0.8, 1 + gap / Math.max(targetPct, 1)))
  if (isSafe) {
    if (rsi < 42 && mom > -1) return { action: 'BUY', confidence: 72, signal: 'SAFE_OVERSOLD', reasoning: `Safe RSI ${rsi.toFixed(0)} oversold.`, allocPct: 40, urgency: 'NORMAL' }
    if (ema5 > ema20 && rsi < 60) return { action: 'BUY', confidence: 65, signal: 'SAFE_TREND', reasoning: `Safe uptrend RSI ${rsi.toFixed(0)}.`, allocPct: 35, urgency: 'NORMAL' }
    return HOLD
  }
  const uptrend = ema5 >= ema20
  if (rsi < 38 && uptrend && mom > -0.3) return { action: 'BUY', confidence: Math.min(93, 62+(38-rsi)*1.4*agg), signal: 'RSI_OVERSOLD_BOUNCE', reasoning: `RSI ${rsi.toFixed(0)} oversold in uptrend — pullback buy.`, allocPct: Math.min(38, 14+(38-rsi)*0.8), urgency: 'NORMAL' }
  if (ema5 > ema20*1.001 && mom > 0.4 && rsi > 44 && rsi < 67) return { action: 'BUY', confidence: Math.min(88, 52+mom*9*agg), signal: 'MOMENTUM_BREAKOUT', reasoning: `EMA cross + mom +${mom.toFixed(2)}%, RSI ${rsi.toFixed(0)}.`, allocPct: Math.min(32, 14+mom*4), urgency: 'NORMAL' }
  if (uptrend && vol > 0.6 && mom > 0.25 && rsi > 48 && rsi < 70) return { action: 'BUY', confidence: 70, signal: 'VOLATILITY_BREAKOUT', reasoning: `Vol expansion ${vol.toFixed(2)}% in uptrend.`, allocPct: 18, urgency: 'NORMAL' }
  if (agg > 1.35 && uptrend && mom > 0.15 && rsi > 42 && rsi < 65 && session === 'regular') return { action: 'BUY', confidence: 66, signal: 'AGGRESSIVE_MOMENTUM', reasoning: `Behind target ${gap.toFixed(1)}%, uptrend RSI ${rsi.toFixed(0)}.`, allocPct: Math.min(28, 12+agg*4), urgency: 'NORMAL' }
  return HOLD
}

export function rankCandidates(watchlist: string[], quotes: Record<string, Quote>, bars: Record<string, number[]>, spyChange: number, targetPct: number, returnPct: number): string[] {
  const scored: { sym: string; score: number }[] = []
  for (const sym of watchlist) {
    if (sym === 'SPY' || SAFE_STOCKS.includes(sym)) continue
    const q = quotes[sym]; if (!q || q.price <= 0) continue
    const b = bars[sym] || []; if (b.length < 6) continue
    const rs = q.changePct - spyChange
    if (rs <= 0 || q.changePct <= 0) continue
    if (q.price <= vwapProxy(b)) continue
    const base = troyBaseline(b, 100, targetPct, returnPct, 'regular', false)
    if (base.action !== 'BUY' || base.confidence < 63) continue
    const mom = calcMomentum(b, Math.min(5, b.length - 1))
    scored.push({ sym, score: base.confidence * (1 + Math.max(0, rs)) * (1 + Math.max(0, mom)) })
  }
  return scored.sort((a, b) => b.score - a.score).map(s => s.sym)
}
