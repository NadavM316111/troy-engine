/* SWING REPORT - the swing section of the daily email. */
import { loadBook, swingTrades } from './db.js'
import { etDayKey } from '../quotes.js'
import { PROFILES, type ProfileId } from './core.js'

/* What the backtest said to expect, so the live numbers have a yardstick.
   2017-2026, 71 stocks, 5bp per side (quant/swing.ts and quant/winrate.ts). */
export const EXPECTED: Record<ProfileId, { winRate: number; avgWinPct: number; avgLossPct: number; expPct: number; pf: number; cagrPct: number; tradesPerYear: number }> = {
  COMBO:   { winRate: 52.3, avgWinPct: 9.67, avgLossPct: -5.03, expPct: 2.56, pf: 2.04, cagrPct: 27.3, tradesPerYear: 111 },
  HIGHWIN: { winRate: 75.9, avgWinPct: 1.89, avgLossPct: -3.69, expPct: 0.44, pf: 1.48, cagrPct: 9.6, tradesPerYear: 220 },
  TROY:    { winRate: 52, avgWinPct: 9.7, avgLossPct: -5.0, expPct: 2.5, pf: 2.0, cagrPct: 66, tradesPerYear: 130 },
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const label = (day: number) => new Date(day * 86400000).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })

export async function swingSection(userId: string): Promise<string> {
  const parts: string[] = []
  for (const id of ['TROY'] as ProfileId[]) parts.push(await bookSection(userId, id))
  return parts.join('')
}

async function bookSection(userId: string, id: ProfileId): Promise<string> {
  const book = await loadBook(userId, id)
  if (!book) return ''
  const trades = await swingTrades(userId, id)
  const today = etDayKey()
  const sells = trades.filter((t: any) => t.action === 'SELL' && t.pnl != null && !String(t.reason ?? '').startsWith('trim'))
  const w = sells.filter((t: any) => Number(t.net) > 0), l = sells.filter((t: any) => Number(t.net) <= 0)
  const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
  const gw = sells.filter((t: any) => Number(t.pnl) > 0).reduce((a: number, t: any) => a + Number(t.pnl), 0)
  const gl = -sells.filter((t: any) => Number(t.pnl) <= 0).reduce((a: number, t: any) => a + Number(t.pnl), 0)
  const winRate = sells.length ? 100 * w.length / sells.length : 0
  const hist = book.equityHistory
  const prev = hist.length > 1 ? hist[hist.length - 2].v : book.budget
  const dayChg = book.equity - prev
  const total = book.equity - book.budget
  let peak = book.budget, mdd = 0
  for (const h of hist) { peak = Math.max(peak, h.v); mdd = Math.max(mdd, 1 - h.v / peak) }
  const E = EXPECTED[id]
  const td = 'padding:5px 8px;border-bottom:1px solid #eee'
  const tdr = `${td};text-align:right`
  const todays = trades.filter((t: any) => Number(t.day) === today)
  const fills = todays.map((t: any) => `<tr><td style="${td};font-weight:600">${esc(t.action)}</td><td style="${td}">${esc(t.ticker)}</td><td style="${td};color:#888">${esc(t.leg)}</td><td style="${tdr}">$${Number(t.price).toFixed(2)}</td><td style="${tdr}">${t.pnl != null ? `<span style="color:${Number(t.pnl) >= 0 ? '#2d7a4f' : '#c0392b'}">${money(Number(t.pnl))} (${pct(Number(t.ret) * 100)})</span>` : money(Number(t.total))}</td></tr>`).join('')
  const btcRow = book.btc && book.btc.units > 0 ? (() => { const now = book.btc!.lastPx ?? book.btc!.avgPx, rr = (now / book.btc!.avgPx - 1) * 100; return `<tr><td style="${td};font-weight:600">BTC</td><td style="${td};color:#888">TREND</td><td style="${td};color:#888">since ${label(book.btc!.sinceDay)} &middot; ${money(book.btc!.units * now)}</td><td style="${tdr}">$${book.btc!.avgPx.toFixed(0)} &rarr; $${now.toFixed(0)}</td><td style="${tdr};color:${rr >= 0 ? '#2d7a4f' : '#c0392b'}">${pct(rr)}</td></tr>` })() : ''
  const pos = book.positions.map(p => {
    const now = p.lastPx ?? p.entryPx, r = (now / p.entryPx - 1) * 100
    return `<tr><td style="${td};font-weight:600">${esc(p.sym)}</td><td style="${td};color:#888">${p.leg}</td><td style="${td};color:#888">since ${label(p.entryDay)}</td><td style="${tdr}">$${p.entryPx.toFixed(2)} &rarr; $${now.toFixed(2)}</td><td style="${tdr};color:${r >= 0 ? '#2d7a4f' : '#c0392b'}">${pct(r)}</td></tr>`
  }).join('')
  const pend = book.pending
  const orders = pend ? [
    ...(pend.btc ? [`<li style="margin:3px 0"><b>${pend.btc.targetValue > 0 ? 'SET BTC to ' + money(pend.btc.targetValue) : 'SELL all BTC'}</b>: ${esc(pend.btc.why)}</li>`] : []),
    ...pend.exits.map(x => `<li style="margin:3px 0"><b>SELL ${esc(x.sym)}</b>: ${esc(x.reason)}</li>`),
    ...pend.entries.map(x => `<li style="margin:3px 0"><b>BUY ${esc(x.sym)}</b> (${x.leg}): ${esc(x.why)}</li>`),
  ].join('') : ''
  const sec = (t: string) => `<div style="font-size:11px;letter-spacing:.1em;color:#999;text-transform:uppercase;margin:16px 0 8px">${t}</div>`

  return `<div style="padding:20px 28px;border-top:6px solid #f4f4f4">
    <div style="font-size:11px;letter-spacing:.12em;color:#999;text-transform:uppercase">${esc(PROFILES[id].title)} · started ${label(book.startedDay)}</div>
    <div style="font-size:26px;font-weight:600;margin-top:6px">${money(book.equity)}</div>
    <div style="font-size:14px;margin-top:2px;color:${dayChg >= 0 ? '#2d7a4f' : '#c0392b'}">${money(dayChg)} today · <span style="color:${total >= 0 ? '#2d7a4f' : '#c0392b'}">${money(total)} (${pct(100 * total / book.budget)}) since start</span></div>
    <div style="font-size:12px;color:#666;margin-top:6px">${book.positions.length} stocks${book.btc ? ' + Bitcoin' : ''} · cash ${money(book.cash)}${book.cash < 0 ? ' (borrowed)' : ''} · leverage ${(((book.positions.reduce((a, p) => a + p.shares * (p.lastPx ?? p.entryPx), 0) + (book.btc ? book.btc.units * (book.btc.lastPx ?? book.btc.avgPx) : 0)) / Math.max(1, book.equity))).toFixed(2)}x · interest ${money(book.interest ?? 0)} · max drawdown so far ${(mdd * 100).toFixed(1)}%</div>
    ${sec('Scorecard vs backtest')}
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td style="${td};color:#999"></td><td style="${tdr};color:#999">Live</td><td style="${tdr};color:#999">Backtest</td></tr>
      <tr><td style="${td}">Growth per year</td><td style="${tdr}">-</td><td style="${tdr}">${E.cagrPct}%</td></tr>
      <tr><td style="${td}">Closed trades</td><td style="${tdr}">${sells.length}</td><td style="${tdr}">~${E.tradesPerYear}/yr</td></tr>
      <tr><td style="${td}">Win rate</td><td style="${tdr};font-weight:600">${sells.length ? winRate.toFixed(1) + '%' : '-'}</td><td style="${tdr}">${E.winRate}%</td></tr>
      <tr><td style="${td}">Avg win / avg loss</td><td style="${tdr}">${sells.length ? `${pct(100 * mean(w.map((t: any) => Number(t.ret))))} / ${pct(100 * mean(l.map((t: any) => Number(t.ret))))}` : '-'}</td><td style="${tdr}">${pct(E.avgWinPct)} / ${pct(E.avgLossPct)}</td></tr>
      <tr><td style="${td}">Avg trade after costs</td><td style="${tdr}">${sells.length ? pct(100 * mean(sells.map((t: any) => Number(t.net)))) : '-'}</td><td style="${tdr}">${pct(E.expPct)}</td></tr>
      <tr><td style="${td}">Profit factor</td><td style="${tdr}">${gl > 0 ? (gw / gl).toFixed(2) : '-'}</td><td style="${tdr}">${E.pf}</td></tr>
    </table>
    <div style="font-size:11px;color:#999;margin-top:6px;line-height:1.5">${sells.length < 30 ? `Only ${sells.length} closed trades. Under ~30, win rate swings wildly by chance; judge it after a few months.` : 'Sample is large enough to start comparing with the backtest.'}</div>
    ${fills ? `${sec('Filled at today\'s open')}<table style="width:100%;border-collapse:collapse;font-size:12px">${fills}</table>` : ''}
    ${pos || btcRow ? `${sec('Holding')}<table style="width:100%;border-collapse:collapse;font-size:12px">${btcRow}${pos}</table>` : `${sec('Holding')}<div style="font-size:12px;color:#888">No positions yet. The book fills as signals appear, usually over the first few weeks.</div>`}
    ${sec('Orders for tomorrow\'s open')}${orders ? `<ul style="margin:0;padding-left:18px;font-size:12px">${orders}</ul>` : '<div style="font-size:12px;color:#888">None. No signals tonight.</div>'}
  </div>`
}
