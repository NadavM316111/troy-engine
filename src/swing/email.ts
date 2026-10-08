/* ═══════════════════════════════════════════════════════════════════════════
   TROY EMAIL - one email a day about the one book.

   Sent once the 16:20 decision has run (retried until 19:55), so it always
   shows today's result and tomorrow's orders. The book records the day it was
   emailed, so restarts and retries cannot double-send. Holidays: no decision,
   no email.
   ═══════════════════════════════════════════════════════════════════════════ */
import { Resend } from 'resend'
import { activeUsers, log } from '../db.js'
import { etDayKey } from '../quotes.js'
import { loadBook, saveBook } from './db.js'
import { swingSection } from './report.js'

const resend = new Resend(process.env.RESEND_API_KEY!)
const FROM = process.env.EMAIL_FROM ?? 'Troy <troy@troyai.co>'
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export async function sendTroyEmails() {
  const today = etDayKey()
  for (const u of await activeUsers()) {
    if (!u.email_enabled) continue
    try {
      const book = await loadBook(u.user_id, 'TROY')
      if (!book || book.lastDecisionDay !== today || (book.lastEmailDay ?? 0) >= today) continue
      const hist = book.equityHistory, prev = hist.length > 1 ? hist[hist.length - 2].v : book.budget
      const dayChg = book.equity - prev, dayPct = 100 * dayChg / Math.max(1e-9, prev)
      const label = new Date(today * 86400000).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      const body = await swingSection(u.user_id)
      const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden">
  <div style="padding:22px 28px 0"><div style="font-size:11px;letter-spacing:.12em;color:#999;text-transform:uppercase">Troy · Paper · ${label}</div></div>
  ${body}
  <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6">
    Paper trading on live prices. No real money is at risk. Fills use the official open (stocks) or the live price (Bitcoin), with costs of 0.05% per side on stocks and 0.15% on Bitcoin, 5%/yr on borrowed money and 4%/yr earned on idle cash. Real execution can differ.
  </div>
</div></body></html>`
      await resend.emails.send({ from: FROM, to: u.email, subject: `Troy · ${label} · ${money(dayChg)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%) · ${money(book.equity)}`, html })
      book.lastEmailDay = today
      await saveBook(u.user_id, book)
      await log('info', `[${u.email}] TROY daily email sent`, undefined, u.user_id)
    } catch (e: any) {
      await log('error', 'TROY email failed', { err: String(e?.message ?? e) }, u.user_id)
    }
  }
}
