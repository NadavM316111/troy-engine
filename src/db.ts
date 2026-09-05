/* ═══════════════════════════════════════════════════════════════════════════
   DB — Neon Postgres access.

   Everything the engine needs to survive a restart lives here. The browser kept
   bar history and cooldowns in React refs, which is why every refresh reset the
   pattern detection. Here they are rows.
   ═══════════════════════════════════════════════════════════════════════════ */

import { neon } from '@neondatabase/serverless'
import type { DaySummary, EngineRefs, PortfolioState, Trade, UserRow } from './types.js'
import { emptyRefs } from './types.js'

const sql = neon(process.env.DATABASE_URL!)

export async function activeUsers(): Promise<UserRow[]> {
  const rows = await sql`
    SELECT user_id, email, display_name, active, email_enabled, state
    FROM portfolios WHERE active = TRUE` as any[]
  return rows as UserRow[]
}

export async function loadRefs(userId: string): Promise<EngineRefs> {
  const rows = await sql`SELECT refs FROM engine_state WHERE user_id = ${userId}` as any[]
  if (!rows.length) return emptyRefs()
  return { ...emptyRefs(), ...(rows[0].refs ?? {}) }
}

export async function saveUserTick(userId: string, state: PortfolioState, refs: EngineRefs, trades: Trade[], day: number, row: DaySummary | null) {
  await sql`
    UPDATE portfolios SET state = ${JSON.stringify(state)}::jsonb, updated_at = now()
    WHERE user_id = ${userId}`
  await sql`
    INSERT INTO engine_state (user_id, refs, updated_at) VALUES (${userId}, ${JSON.stringify(refs)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE SET refs = EXCLUDED.refs, updated_at = now()`
  for (const t of trades) {
    await sql`
      INSERT INTO trades (id, user_id, day, ticker, action, shares, price, total, pnl, signal, sleeve, conviction, reasoning, ts)
      VALUES (${t.id}, ${userId}, ${day}, ${t.ticker}, ${t.action}, ${t.shares}, ${t.price}, ${t.total},
              ${t.pnl ?? null}, ${t.signal ?? null}, ${t.sleeve ?? null}, ${t.conviction}, ${t.reasoning}, to_timestamp(${t.timestamp / 1000}))
      ON CONFLICT (id) DO NOTHING`
  }
  if (row) {
    await sql`
      INSERT INTO daily_log (user_id, day, date, row, updated_at)
      VALUES (${userId}, ${row.day}, ${row.date}::date, ${JSON.stringify(row)}::jsonb, now())
      ON CONFLICT (user_id, day) DO UPDATE SET row = EXCLUDED.row, updated_at = now()`
  }
}

export async function loadBars(): Promise<{ bars: Record<string, number[]>; day: number | null }> {
  const rows = await sql`SELECT ticker, bars, session_day FROM bar_history` as any[]
  const bars: Record<string, number[]> = {}
  let day: number | null = null
  for (const r of rows) { bars[r.ticker] = r.bars ?? []; day = r.session_day }
  return { bars, day }
}

export async function saveBars(bars: Record<string, number[]>, day: number) {
  const entries = Object.entries(bars)
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = entries.slice(i, i + 50)
    await Promise.all(chunk.map(([ticker, arr]) => sql`
      INSERT INTO bar_history (ticker, bars, session_day, updated_at)
      VALUES (${ticker}, ${JSON.stringify(arr)}::jsonb, ${day}, now())
      ON CONFLICT (ticker) DO UPDATE SET bars = EXCLUDED.bars, session_day = EXCLUDED.session_day, updated_at = now()`))
  }
}

export async function clearBars() { await sql`DELETE FROM bar_history` }

export async function log(level: 'info'|'warn'|'error', message: string, detail?: unknown, userId?: string) {
  const line = `[${level}] ${message}`
  if (level === 'error') console.error(line, detail ?? ''); else console.log(line, detail ?? '')
  try {
    await sql`INSERT INTO engine_log (user_id, level, message, detail) VALUES (${userId ?? null}, ${level}, ${message}, ${detail ? JSON.stringify(detail) : null}::jsonb)`
  } catch { /* logging must never break the loop */ }
}

/* Single-writer lock. Railway can briefly run two instances across a deploy;
   two engines trading the same book would double-fill and corrupt cash. */
export async function claimLock(holder: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO engine_lock (id, holder, heartbeat) VALUES (1, ${holder}, now())
    ON CONFLICT (id) DO UPDATE SET holder = ${holder}, heartbeat = now()
    WHERE engine_lock.holder = ${holder} OR engine_lock.heartbeat < now() - interval '90 seconds'
    RETURNING holder` as any[]
  return rows.length > 0
}

export async function heartbeat(holder: string) {
  await sql`UPDATE engine_lock SET heartbeat = now() WHERE id = 1 AND holder = ${holder}`
}

/* Daily email support */
export async function unemailedDays(day: number) {
  const rows = await sql`
    SELECT d.user_id, d.day, d.row, p.email, p.display_name, p.email_enabled, p.state
    FROM daily_log d JOIN portfolios p ON p.user_id = d.user_id
    WHERE d.day = ${day} AND d.emailed = FALSE AND p.email_enabled = TRUE` as any[]
  return rows
}

export async function markEmailed(userId: string, day: number) {
  await sql`UPDATE daily_log SET emailed = TRUE WHERE user_id = ${userId} AND day = ${day}`
}

export async function dayTrades(userId: string, day: number) {
  return await sql`SELECT * FROM trades WHERE user_id = ${userId} AND day = ${day} ORDER BY ts ASC` as any[]
}
