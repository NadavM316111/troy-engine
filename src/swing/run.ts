/* ═══════════════════════════════════════════════════════════════════════════
   SWING RUNNER - the live, always-on side of the swing book.

     afterClose()  16:20 ET weekdays, retried every 15 min until 19:45.
                   Pulls daily bars, marks the book, decides tomorrow's orders.
     atOpen()      09:35 ET weekdays, retried every 10 min until 11:50.
                   Fills yesterday's orders at today's official open.

   Both are idempotent: each records the day it last ran, so retries, restarts
   and a second Railway instance cannot double-decide or double-fill. Market
   holidays are detected from the data (no bar for today = market closed), so
   there is no holiday calendar to maintain.
   ═══════════════════════════════════════════════════════════════════════════ */

import { randomUUID } from 'node:crypto'
import { STOCK_LIBRARY } from '../rules.js'
import { activeUsers, log } from '../db.js'
import { etDayKey, etMinutesNow } from '../quotes.js'
import { buildSeries, decide, execute, markEquity, newBook, PROFILES, type DSeries, type SwingBook, type ProfileId } from './core.js'
import { fetchLiveDaily, type LiveDaily } from './data.js'
import { ensureSwingTables, loadBook, saveBook, insertTrades } from './db.js'

export const SWING_UNIVERSE = STOCK_LIBRARY.map(s => s.sym)
let tablesReady = false
let busy = false

async function loadUniverse(range: string): Promise<{ S: Record<string, DSeries>; raw: Record<string, LiveDaily>; failed: string[] }> {
  const S: Record<string, DSeries> = {}, raw: Record<string, LiveDaily> = {}, failed: string[] = []
  for (const sym of ['SPY', ...SWING_UNIVERSE, 'BTC-USD']) {
    const d = await fetchLiveDaily(sym, range)
    if (d && d.bars.length) { raw[sym] = d; S[sym] = buildSeries(d.bars) } else failed.push(sym)
    await new Promise(r => setTimeout(r, 80))
  }
  return { S, raw, failed }
}

/* A split after entry rescales every past price in Yahoo's series. Rescale
   the position to match, once per split. */
function applySplits(book: SwingBook, raw: Record<string, LiveDaily>) {
  for (const p of book.positions) {
    for (const sp of raw[p.sym]?.splits ?? []) {
      if (sp.day <= p.entryDay || (p.splits ?? []).includes(sp.day)) continue
      p.shares *= sp.ratio; p.entryPx /= sp.ratio; (p.splits ??= []).push(sp.day)
    }
  }
}

/* One live book. COMBO and HIGHWIN stay in the database as history only. */
const BOOKS: ProfileId[] = ['TROY']
async function users() {
  const us = await activeUsers()
  return us.map(u => ({ id: u.user_id, email: u.email, budget: u.state.budget || 1_000_000 }))
}
async function allBooks(us: Awaited<ReturnType<typeof users>>) {
  const out: { u: typeof us[number]; profile: ProfileId; book: SwingBook | null }[] = []
  for (const u of us) for (const profile of BOOKS) {
    let book = await loadBook(u.id, profile)
    if (!book && profile === 'TROY') {
      const combo = await loadBook(u.id, 'COMBO')
      if (combo) { book = { ...combo, profile: 'TROY', btc: null, interest: 0, pending: null, lastDecisionDay: 0 }; await saveBook(u.id, book); await log('info', `[${u.email}] TROY book created from the COMBO book (same positions, cash and history)`, undefined, u.id) }
    }
    out.push({ u, profile, book })
  }
  return out
}

export async function afterClose(force = false) {
  if (busy) return; busy = true
  try {
    if (!tablesReady) { await ensureSwingTables(); tablesReady = true }
    const today = etDayKey()
    if (!force && etMinutesNow() < 16 * 60 + 15) return
    const us = await users(); if (!us.length) return
    const books = await allBooks(us)
    if (books.every(b => b.book && b.book.lastDecisionDay >= today)) return
    const { S, raw, failed } = await loadUniverse('2y')
    const spy = S['SPY']; if (!spy) { await log('error', 'swing: SPY daily data missing, skipping decision'); return }
    const lastDay = spy.days[spy.days.length - 1]
    if (lastDay !== today) { await log('info', `swing: no bar for today (${today}), market closed, nothing to decide`); return }
    if (failed.length) await log('warn', `swing: ${failed.length} symbols failed daily fetch`, { failed })
    for (const { u, profile, book: b } of books) {
      const book = b ?? newBook(u.budget, today, profile)
      if (book.lastDecisionDay >= today) continue
      applySplits(book, raw)
      const p = decide(book, S, SWING_UNIVERSE, today, {}, () => randomUUID())
      if (p.closeFills?.length) { await insertTrades(u.id, profile, p.closeFills); p.closeFills = [] }
      book.equityHistory = [...book.equityHistory.filter(x => x.day !== today), { day: today, v: +book.equity.toFixed(2) }].slice(-600)
      await saveBook(u.id, book)
      await log('info', `[${u.email}] ${profile} decided: equity $${book.equity.toFixed(0)}, ${book.positions.length} held${book.btc ? ' + BTC' : ''}, tomorrow sells ${p.exits.map(x => x.sym).join(',') || 'none'}, buys ${p.entries.map(x => `${x.sym}(${x.leg})`).join(',') || 'none'}${p.btc ? `, BTC to $${p.btc.targetValue.toFixed(0)}` : ''}`, undefined, u.id)
    }
  } catch (e: any) {
    await log('error', 'swing afterClose failed', { err: String(e?.stack ?? e) })
  } finally { busy = false }
}

export async function atOpen(force = false) {
  if (busy) return; busy = true
  try {
    if (!tablesReady) { await ensureSwingTables(); tablesReady = true }
    const today = etDayKey()
    if (!force && etMinutesNow() < 9 * 60 + 35) return
    const us = await users(); if (!us.length) return
    const books = (await allBooks(us)).filter(b => b.book?.pending && b.book.pending.decidedOn < today && b.book.lastExecDay < today)
    if (!books.length) return
    const { S, raw } = await loadUniverse('3mo')
    const spy = S['SPY']
    if (!spy || spy.days[spy.days.length - 1] !== today) { await log('info', `swing: no bar for today (${today}) yet or market closed, holding orders`); return }
    for (const { u, profile, book } of books) {
      applySplits(book!, raw)
      const b = S['BTC-USD']
      const btcNow = b ? b.fc[b.days.length - 1] : undefined
      const fills = execute(book!, S, today, () => randomUUID(), { btcFillPx: btcNow })
      book!.equity = markEquity(book!, S, today)
      await insertTrades(u.id, profile, fills)
      await saveBook(u.id, book!)
      if (fills.length) await log('info', `[${u.email}] ${profile} filled at open: ${fills.map(f => `${f.action} ${f.sym} $${f.price.toFixed(2)}${f.pnl != null ? ` (${f.pnl >= 0 ? '+' : ''}$${f.pnl.toFixed(0)})` : ''}`).join(' | ')}`, undefined, u.id)
    }
  } catch (e: any) {
    await log('error', 'swing atOpen failed', { err: String(e?.stack ?? e) })
  } finally { busy = false }
}
