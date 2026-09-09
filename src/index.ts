/* ═══════════════════════════════════════════════════════════════════════════
   TROY ENGINE — the always-on loop.

   This is what makes "no overnight exposure" a true statement. Previously the
   engine only ran while a browser tab was open, so if the tab was closed at
   15:00 the 15:55 flatten never fired and positions carried over silently.

   Cadence:
     * every 8s during premarket / regular / afterhours
     * idle poll every 60s when the market is closed
     * bar history flushed to Postgres every 60s, and cleared on a new ET day
     * daily emails after the flatten
   ═══════════════════════════════════════════════════════════════════════════ */

import 'dotenv/config'
import cron from 'node-cron'
import { randomUUID } from 'node:crypto'
import { runEngine } from './engine.js'
import { getQuotes, getMarketSession, etMinutesNow, etDayKey } from './quotes.js'
import { sendDailyEmails } from './email.js'
import {
  activeUsers, loadRefs, saveUserTick, loadBars, saveBars, clearBars,
  claimLock, heartbeat, log,
} from './db.js'
import { STOCK_LIBRARY, SAFE_STOCKS } from './rules.js'

const TICK_MS = 8000
const IDLE_MS = 60000
const HOLDER = process.env.RAILWAY_REPLICA_ID ?? randomUUID()

let bars: Record<string, number[]> = {}
let barsDay = 0
let lastBarFlush = 0
let running = false
/* Rejection reasons accumulate across ticks and get flushed every 15 minutes.
   Per-tick would be thousands of rows a session; per-quarter-hour is readable. */
let rejAcc: Record<string, Record<string, number>> = {}
let lastRejFlush = 0

async function tick() {
  if (running) return          // never overlap; a slow quote fetch must not stack
  running = true
  try {
    if (!(await claimLock(HOLDER))) {
      await log('warn', 'another instance holds the engine lock — standing down this tick')
      return
    }

    const { session } = getMarketSession()
    if (session === 'closed') return

    const users = await activeUsers()
    if (!users.length) return

    const etMin = etMinutesNow()
    const today = etDayKey()

    // New trading day: bar history from yesterday is not comparable, so drop it.
    if (barsDay !== today) {
      await clearBars()
      bars = {}; barsDay = today
      await log('info', `new session ${today} — bar history cleared`)
    }

    // One quote fetch for everyone. Same SPY print for every user, which is
    // what stops two accounts landing in different regimes on the same day.
    const tickers = [...new Set<string>([
      'SPY', 'QQQ',
      ...users.flatMap(u => u.state.stocks ?? []),
      ...users.flatMap(u => u.state.positions.map(p => p.ticker)),
      ...users.flatMap(u => u.state.roster ?? []),
      ...users.flatMap(u => u.state.bench ?? []),
      ...(users.some(u => u.state.aiPicksStocks) ? STOCK_LIBRARY.map(s => s.sym) : []),
      ...(users.some(u => !u.state.allIn) ? SAFE_STOCKS : []),
    ])]

    const { quotes, dataSource, failed } = await getQuotes(tickers)
    if (!Object.keys(quotes).length) { await log('error', 'quote fetch returned nothing — skipping tick'); return }
    if (failed.length > 8) await log('warn', `${failed.length} symbols failed to quote`, { failed: failed.slice(0, 12) })

    // Append to shared bar history.
    for (const [sym, q] of Object.entries(quotes)) {
      if (q.price <= 0) continue
      const a = bars[sym] ?? (bars[sym] = [])
      if (a.length === 0 || a[a.length - 1] !== q.price) a.push(q.price)
      if (a.length > 120) a.shift()
    }

    for (const u of users) {
      try {
        const refs = await loadRefs(u.user_id)
        const out = runEngine({ state: u.state, refs, quotes, bars, session, etMin })
        const row = out.state.dailyLog.find(d => d.day === today) ?? null
        await saveUserTick(u.user_id, out.state, out.refs, out.newTrades, today, row)
        if (out.execLog.length) await log('info', `[${u.email}] ${out.execLog.join(' | ')}`, { dataSource }, u.user_id)
        const acc = rejAcc[u.user_id] ?? (rejAcc[u.user_id] = {})
        for (const [k, v] of Object.entries(out.rejects)) acc[k] = (acc[k] ?? 0) + v
        acc.__gate = 0
        ;(acc as any).__lastGate = out.gate as any
      } catch (e: any) {
        // One user's bad state must never stop the others from trading.
        await log('error', `engine failed for user`, { err: String(e?.stack ?? e) }, u.user_id)
      }
    }

    if (Date.now() - lastBarFlush > 60000) { lastBarFlush = Date.now(); await saveBars(bars, today) }

    /* Every 15 minutes, write why entries were rejected. If the engine takes no
       trades, this is the difference between "the filters are too tight" and
       "nothing qualified", which look identical from the outside. */
    if (session === 'regular' && Date.now() - lastRejFlush > 15 * 60 * 1000) {
      lastRejFlush = Date.now()
      for (const u of users) {
        const acc = rejAcc[u.user_id]
        if (!acc) continue
        const gate = (acc as any).__lastGate
        const reasons = Object.fromEntries(
          Object.entries(acc).filter(([k]) => !k.startsWith('__')).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 12)
        )
        const top = Object.entries(reasons).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(' ')
        await log('info', `[${u.email}] entry rejects (15m): ${top || 'none'}`, { etMin, gate, reasons }, u.user_id)
      }
      rejAcc = {}
    }
    await heartbeat(HOLDER)
  } catch (e: any) {
    await log('error', 'tick failed', { err: String(e?.stack ?? e) })
  } finally {
    running = false
  }
}

async function main() {
  await log('info', `Troy engine starting — holder ${HOLDER}`)
  const restored = await loadBars()
  bars = restored.bars; barsDay = restored.day ?? etDayKey()
  await log('info', `restored bar history for ${Object.keys(bars).length} symbols`)

  // Daily report at 16:05 ET, after the 15:55 flatten has settled.
  cron.schedule('5 16 * * 1-5', () => { sendDailyEmails().catch(e => log('error', 'email job failed', { err: String(e) })) }, { timezone: 'America/New_York' })

  const loop = async () => {
    const { session } = getMarketSession()
    await tick()
    setTimeout(loop, session === 'closed' ? IDLE_MS : TICK_MS)
  }
  loop()
}

process.on('unhandledRejection', e => { log('error', 'unhandled rejection', { err: String(e) }) })
process.on('uncaughtException',  e => { log('error', 'uncaught exception',  { err: String(e?.stack ?? e) }) })

main()
