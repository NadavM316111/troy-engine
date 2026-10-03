/* npm run stats  — prints the scorecard for every active user. */
import 'dotenv/config'
import { allUsers } from './db.js'
import { buildScorecard, scoreLine } from './stats.js'

const users = await allUsers()
for (const u of users) {
  const c = await buildScorecard(u.user_id)
  console.log(`\n=== ${u.email} ===`)
  console.log(scoreLine('Today   ', c.today))
  console.log(scoreLine('Last 10d', c.last10))
  console.log(scoreLine('All time', c.allTime))
  console.log(`Days: ${c.days.n} closed, ${c.days.greenPct}% green, max drawdown ${c.days.maxDrawdownPct}%`)
  console.log('\nBy signal (worst first):')
  for (const s of c.bySignal) console.log(`  ${s.signal.padEnd(22)} n=${String(s.n).padStart(4)}  win=${String(s.winRate).padStart(5)}%  exp=$${s.expectancy}  net=$${s.net}`)
}
process.exit(0)
