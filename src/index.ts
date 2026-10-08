/* ═══════════════════════════════════════════════════════════════════════════
   TROY ENGINE — the always-on loop.

   This is what makes "no overnight exposure" a true statement. Previously the
   engine only ran while a browser tab was open, so if the tab was closed at
   15:00 the 15:55 flatten never fired and positions carried over silently.

   Cadence:
     * every 10s during the regular session (was 5s)
     * every 2 min in premarket (04:00-09:30) and afterhours (16:00-20:00)
     * overnight (20:00-04:00) and weekends: a night scan every 5 hours,
       always waking in time for the 04:00 open
     * scorecard checkpoints logged at 09:30, 11:30, 14:00 and 16:00 ET
     * bar history flushed to Postgres every 60s, cleared on a new ET day
     * entry-rejection telemetry flushed every 15 minutes
     * daily emails after the flatten
     * swing book: decides at 16:20 ET, fills at 09:35 ET (see swing/run.ts)
   ═══════════════════════════════════════════════════════════════════════════ */

import 'dotenv/config'
import cron from 'node-cron'
import { randomUUID } from 'node:crypto'
import { runEngine } from './engine.js'
import { getQuotes, getMarketSession, etMinutesNow, etDayKey, etParts } from './quotes.js'
import { sendDailyEmails } from './email.js'
import { sendTroyEmails } from './swing/email.js'

/* One book. The intraday engine is off unless TROY_INTRADAY=on is set in Railway.
   Its code stays, so it can be switched back on without a deploy. */
const INTRADAY_ENABLED = process.env.TROY_INTRADAY === 'on'
import {
  activeUsers, loadRefs, saveUserTick, loadBars, saveBars, clearBars,
  claimLock, heartbeat, log,
} from './db.js'
import { STOCK_LIBRARY, SAFE_STOCKS } from './rules.js'
import { buildScorecard, scoreLine } from './stats.js'
import { afterClose as swingAfterClose, atOpen as swingAtOpen } from './swing/run.js'

/* 10s, was 5s. Bars are tick prices, so every `bars.length >= N` threshold in
   the rules is implicitly a time window. At 10s, ten bars is 100 seconds rather
   than 50, and the 120-bar history covers 20 minutes instead of 10. Each bar
   now carries more real movement and less quote noise, so patterns form on
   thicker evidence. Expect fewer trades. Watch the scorecard, not the count. */
const TICK_MS       = 10 * 1000
const EXTENDED_MS   = 2 * 60 * 1000        // premarket + afterhours
const NIGHT_MS      = 5 * 60 * 60 * 1000   // 20:00-04:00 and weekends
const HOLDER = process.env.RAILWAY_REPLICA_ID ?? randomUUID()

let bars: Record<string, number[]> = {}
let barsDay = 0
let lastBarFlush = 0
let running = false

/* Rejection reasons accumulate across ticks and flush every 15 minutes.
   Per-tick would be thousands of rows a session; per-quarter-hour is readable. */
let rejAcc: Record<string, Record<string, number>> = {}
let lastGate: Record<string, unknown> = {}
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

    // New trading day: yesterday's bar history is not comparable, so drop it.
    if (barsDay !== today) {
      await clearBars()
      bars = {}; barsDay = today
      await log('info', `new session ${today} — bar history cleared`)
    }

    // One quote fetch for everyone. Same SPY print for every user, which is what
    // stops two accounts landing in different regimes on the same afternoon.
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
        lastGate[u.user_id] = out.gate
      } catch (e: any) {
        // One user's bad state must never stop the others from trading.
        await log('error', `engine failed for user`, { err: String(e?.stack ?? e) }, u.user_id)
      }
    }

    if (Date.now() - lastBarFlush > 60000) { lastBarFlush = Date.now(); await saveBars(bars, today) }

    /* Every 15 minutes, write why entries were rejected. If the engine takes no
       trades, this is the difference between "the filters are too tight" and
       "nothing qualified" — which look identical from the outside. */
    if (session === 'regular' && Date.now() - lastRejFlush > 15 * 60 * 1000) {
      lastRejFlush = Date.now()
      for (const u of users) {
        const acc = rejAcc[u.user_id]
        if (!acc) continue
        const reasons = Object.fromEntries(
          Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 12)
        )
        const top = Object.entries(reasons).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(' ')
        await log('info', `[${u.email}] entry rejects (15m): ${top || 'none'}`, { etMin, gate: lastGate[u.user_id], reasons }, u.user_id)
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

/* Overnight there is nothing to trade, so this only records where the market
   is drifting (futures-driven ETF prints, earnings movers) so the morning has
   context in the log. Never touches a portfolio. */
async function nightScan() {
  try {
    if (!(await claimLock(HOLDER))) return
    const users = await activeUsers()
    const tickers = [...new Set<string>(['SPY', 'QQQ', ...users.flatMap(u => u.state.stocks ?? [])])]
    const { quotes } = await getQuotes(tickers)
    const movers = Object.entries(quotes)
      .filter(([s]) => s !== 'SPY' && s !== 'QQQ')
      .sort((a, b) => Math.abs(b[1].changePct) - Math.abs(a[1].changePct))
      .slice(0, 8)
      .map(([s, q]) => `${s} ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`)
    await log('info', `night scan: SPY ${quotes.SPY?.changePct ?? '?'}% QQQ ${quotes.QQQ?.changePct ?? '?'}% | movers ${movers.join(', ') || 'none'}`)
    await heartbeat(HOLDER)
  } catch (e: any) {
    await log('error', 'night scan failed', { err: String(e?.stack ?? e) })
  }
}

/* Checkpoints. These replace the "rest times" idea: the engine is rules-only,
   nothing in it tires, so pausing would just miss trades (09:30 is the busiest
   window of the day). What is useful at those times is a snapshot of how the
   book is actually doing, written to engine_log so the trend is visible. */
async function checkpoint(label: string) {
  try {
    const users = await activeUsers()
    for (const u of users) {
      const c = await buildScorecard(u.user_id)
      await log('info', `[${u.email}] checkpoint ${label} | ${scoreLine('today', c.today)} | ${scoreLine('all', c.allTime)}`, undefined, u.user_id)
    }
  } catch (e: any) {
    await log('error', 'checkpoint failed', { err: String(e?.stack ?? e) })
  }
}

function nextDelay(): number {
  const { session, nextOpen } = getMarketSession()
  if (session === 'regular') return TICK_MS
  if (session === 'premarket' || session === 'afterhours') return EXTENDED_MS
  // Closed: sleep up to 5h, but never past the 04:00 open. nextOpen is built on
  // the ET wall-clock basis, so compare it against "now" on the same basis.
  const untilOpen = nextOpen > 0 ? nextOpen - etParts(Date.now()).getTime() : NIGHT_MS
  return Math.max(60 * 1000, Math.min(NIGHT_MS, untilOpen + 5000))
}

async function main() {
  await log('info', `Troy engine starting — holder ${HOLDER}`)
  const restored = await loadBars()
  bars = restored.bars; barsDay = restored.day ?? etDayKey()
  await log('info', `restored bar history for ${Object.keys(bars).length} symbols`)

  const tz = { timezone: 'America/New_York' }
  // Daily report at 16:40 ET, after the 16:30 self-reflection, so the email shows today's.
  if (INTRADAY_ENABLED) cron.schedule('40 16 * * 1-5', () => { sendDailyEmails().catch(e => log('error', 'email job failed', { err: String(e) })) }, tz)
  // The TROY email: after the 16:20 decision, retried until 19:55 (sends once a day)
  const emailGuard = async () => { try { if (await claimLock(HOLDER)) await sendTroyEmails() } catch (e: any) { await log('error', 'TROY email job failed', { err: String(e?.stack ?? e) }) } }
  cron.schedule('40,55 16 * * 1-5', emailGuard, tz)
  cron.schedule('*/15 17-19 * * 1-5', emailGuard, tz)
  /* Swing book. Decide after the close, fill at the next open. The retries
     make a missed run (restart, slow data) self-heal; both jobs are no-ops
     once they have done today's work, and only the lock holder runs them. */
  const swingGuard = (fn: () => Promise<void>) => async () => { try { if (await claimLock(HOLDER)) await fn() } catch (e: any) { await log('error', 'swing job failed', { err: String(e?.stack ?? e) }) } }
  cron.schedule('20,35,50 16 * * 1-5', swingGuard(swingAfterClose), tz)
  cron.schedule('*/15 17-19 * * 1-5', swingGuard(swingAfterClose), tz)
  cron.schedule('35,45,55 9 * * 1-5', swingGuard(swingAtOpen), tz)
  cron.schedule('*/10 10-11 * * 1-5', swingGuard(swingAtOpen), tz)
  // On boot, catch up anything a restart may have skipped.
  swingGuard(swingAtOpen)().then(swingGuard(swingAfterClose)).then(emailGuard)

  if (INTRADAY_ENABLED) {
    cron.schedule('30 9 * * 1-5',  () => { checkpoint('09:30') }, tz)
    cron.schedule('30 11 * * 1-5', () => { checkpoint('11:30') }, tz)
    cron.schedule('0 14 * * 1-5',  () => { checkpoint('14:00') }, tz)
    cron.schedule('0 16 * * 1-5',  () => { checkpoint('16:00') }, tz)
  }

  /* Ticks can now be minutes or hours apart, longer than the 90s lock window.
     Heartbeat on its own clock so a second instance cannot grab the lock
     between ticks and double-trade the book. */
  setInterval(() => { heartbeat(HOLDER).catch(() => {}) }, 30 * 1000)

  const loop = async () => {
    const { session } = getMarketSession()
    if (!INTRADAY_ENABLED) { /* one-book mode: the swing jobs run on their own schedule */ }
    else if (session === 'closed') await nightScan(); else await tick()
    setTimeout(loop, nextDelay())
  }
  loop()
}

process.on('unhandledRejection', e => { log('error', 'unhandled rejection', { err: String(e) }) })
process.on('uncaughtException',  e => { log('error', 'uncaught exception',  { err: String(e?.stack ?? e) }) })

main()
