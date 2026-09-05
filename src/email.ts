/* ═══════════════════════════════════════════════════════════════════════════
   EMAIL — end-of-day report via Resend.

   Sent once per user per trading day, after the 15:55 flatten. The `emailed`
   flag on daily_log makes it idempotent, so a restart cannot double-send.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Resend } from 'resend'
import type { DaySummary } from './types.js'
import { dayTrades, markEmailed, unemailedDays, log } from './db.js'
import { etDayKey } from './quotes.js'

const resend = new Resend(process.env.RESEND_API_KEY!)
const FROM = process.env.EMAIL_FROM ?? 'Troy <troy@troyai.co>'

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
const pct   = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const esc   = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!))

function buildHtml(name: string, row: DaySummary, trades: any[], state: any): string {
  const up = row.pnl >= 0
  const col = up ? '#2d7a4f' : '#c0392b'
  const fills = trades.map(t => {
    const p = t.pnl == null ? '' : `<span style="color:${t.pnl >= 0 ? '#2d7a4f' : '#c0392b'}">${money(Number(t.pnl))}</span>`
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600">${esc(t.action)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(t.ticker)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">$${Number(t.price).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${money(Number(t.total))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${p}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888;font-size:11px">${esc(t.signal ?? '')}</td>
    </tr>`
  }).join('')

  const positions = (state.positions ?? []).map((p: any) =>
    `<li style="margin:3px 0">${esc(p.ticker)} — ${p.shares.toFixed(4)}sh @ $${p.avgPrice.toFixed(2)}, now $${p.currentPrice.toFixed(2)} (${pct(p.pnlPct)})</li>`
  ).join('') || '<li style="color:#888">Flat. No overnight exposure.</li>'

  const reflection = (state.lessonsLedger ?? [])[0]

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden">
  <div style="padding:24px 28px;border-bottom:1px solid #eee">
    <div style="font-size:11px;letter-spacing:.12em;color:#999;text-transform:uppercase">Troy Invest · Paper</div>
    <div style="font-size:22px;font-weight:600;margin-top:4px">${esc(row.label)}</div>
  </div>
  <div style="padding:24px 28px">
    <div style="font-size:34px;font-weight:600">${money(row.closeValue)}</div>
    <div style="font-size:18px;color:${col};margin-top:2px">${money(row.pnl)} · ${pct(row.pnlPct)} today</div>
    <table style="width:100%;margin-top:20px;font-size:13px;border-collapse:collapse">
      <tr><td style="padding:4px 0;color:#666">Opened at</td><td style="text-align:right">${money(row.openValue)}</td></tr>
      <tr><td style="padding:4px 0;color:#666">Intraday high / low</td><td style="text-align:right">${money(row.high)} / ${money(row.low)}</td></tr>
      <tr><td style="padding:4px 0;color:#666">Fills</td><td style="text-align:right">${row.trades} · ${row.wins}W / ${row.losses}L</td></tr>
      <tr><td style="padding:4px 0;color:#666">Trading sleeve / Safe</td><td style="text-align:right">${money(row.mainPnl)} / ${money(row.safePnl)}</td></tr>
      <tr><td style="padding:4px 0;color:#666">Regime / mode</td><td style="text-align:right">${esc(row.regime)} · ${esc(row.mode)}</td></tr>
      <tr><td style="padding:4px 0;color:#666">All time</td><td style="text-align:right;color:${state.totalPnl >= 0 ? '#2d7a4f' : '#c0392b'}">${money(state.totalPnl)} · ${pct(state.totalPnlPct)}</td></tr>
    </table>
  </div>
  ${fills ? `<div style="padding:0 28px 20px">
    <div style="font-size:11px;letter-spacing:.1em;color:#999;text-transform:uppercase;margin-bottom:8px">Fills</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">${fills}</table>
  </div>` : '<div style="padding:0 28px 20px;color:#888;font-size:13px">No fills today. Zero trades is a valid output, not a failure.</div>'}
  <div style="padding:0 28px 20px">
    <div style="font-size:11px;letter-spacing:.1em;color:#999;text-transform:uppercase;margin-bottom:8px">Held overnight</div>
    <ul style="margin:0;padding-left:18px;font-size:13px">${positions}</ul>
  </div>
  ${reflection ? `<div style="padding:0 28px 24px">
    <div style="font-size:11px;letter-spacing:.1em;color:#999;text-transform:uppercase;margin-bottom:8px">Self-reflection</div>
    <pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.6;background:#fafafa;border:1px solid #eee;border-radius:8px;padding:14px;margin:0">${esc(reflection)}</pre>
  </div>` : ''}
  <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6">
    Paper trading on live prices. No real money is at risk. These results come from simulated fills at last price, with no spread or slippage modelled, so real-world execution would be worse.
  </div>
</div></body></html>`
}

export async function sendDailyEmails() {
  const day = etDayKey()
  const rows = await unemailedDays(day)
  if (!rows.length) return
  for (const r of rows) {
    try {
      const row: DaySummary = r.row
      const trades = await dayTrades(r.user_id, day)
      const html = buildHtml(r.display_name ?? 'there', row, trades, r.state)
      await resend.emails.send({
        from: FROM, to: r.email,
        subject: `Troy · ${row.label} · ${money(row.pnl)} (${pct(row.pnlPct)})`,
        html,
      })
      await markEmailed(r.user_id, day)
      await log('info', `daily email sent`, { to: r.email }, r.user_id)
    } catch (e: any) {
      await log('error', `daily email failed`, { err: String(e?.message ?? e) }, r.user_id)
    }
  }
}
