/* SWING DB - the swing book lives in its own tables, apart from the intraday
   book, so the two can be compared cleanly. Tables are created on startup;
   nothing to run by hand. */
import { neon } from '@neondatabase/serverless'
import type { SwingBook, SwingTrade } from './core.js'

const sql = neon(process.env.DATABASE_URL!)

export async function ensureSwingTables() {
  await sql`CREATE TABLE IF NOT EXISTS swing_books (
    user_id text NOT NULL, book text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book))`
  await sql`CREATE TABLE IF NOT EXISTS swing_trades (
    id text PRIMARY KEY, user_id text NOT NULL, book text NOT NULL, day integer NOT NULL, ticker text NOT NULL,
    action text NOT NULL, leg text NOT NULL, shares double precision NOT NULL, price double precision NOT NULL,
    total double precision NOT NULL, pnl double precision, ret double precision, net double precision,
    hold_days integer, reason text, ts timestamptz NOT NULL DEFAULT now())`
  await sql`CREATE INDEX IF NOT EXISTS swing_trades_user_book ON swing_trades (user_id, book, day)`
}

export async function loadBook(userId: string, book: string): Promise<SwingBook | null> {
  const r = await sql`SELECT state FROM swing_books WHERE user_id = ${userId} AND book = ${book}` as any[]
  return r.length ? r[0].state as SwingBook : null
}

export async function saveBook(userId: string, book: SwingBook) {
  await sql`INSERT INTO swing_books (user_id, book, state, updated_at) VALUES (${userId}, ${book.profile}, ${JSON.stringify(book)}::jsonb, now())
    ON CONFLICT (user_id, book) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`
}

export async function insertTrades(userId: string, book: string, trades: SwingTrade[]) {
  for (const t of trades) {
    await sql`INSERT INTO swing_trades (id, user_id, book, day, ticker, action, leg, shares, price, total, pnl, ret, net, hold_days, reason)
      VALUES (${t.id}, ${userId}, ${book}, ${t.day}, ${t.sym}, ${t.action}, ${t.leg}, ${t.shares}, ${t.price}, ${t.total}, ${t.pnl ?? null}, ${t.ret ?? null}, ${t.net ?? null}, ${t.holdDays ?? null}, ${t.reason})
      ON CONFLICT (id) DO NOTHING`
  }
}

export async function swingTrades(userId: string, book: string) {
  return await sql`SELECT * FROM swing_trades WHERE user_id = ${userId} AND book = ${book} ORDER BY ts ASC` as any[]
}
