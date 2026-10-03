# Troy Swing Books

Two separate paper books that hold positions for days instead of minutes. They run on Railway next to the intraday book, and the daily email shows all three so they can be compared head to head.

| Book | Built for | Win rate | Growth | Worst drop |
|---|---|---|---|---|
| Swing: breakout + dips (COMBO) | most money | ~52% | ~27%/yr | ~-22% |
| High win-rate: dips, quick profit (HIGHWIN) | 75%+ wins | ~76% | ~9.6%/yr | ~-19% |

All figures are 2017-2026 backtests on 71 stocks, after costs, and both were confirmed by the parity replay of the live code.

## The strategy

**Combo: 20-day breakout + RSI(2) dips, one shared book.** The only family of strategies that beat buy-and-hold of the same stocks in all three stress tests (full universe, without the 10 biggest winners, and at double trading costs).

| Rule | Definition |
|---|---|
| Uptrend | close > SMA200 |
| Breakout entry | uptrend AND close > max(high, prior 20 days). Ranked by 20-day return. Up to 10 positions. |
| Breakout exit | close < min(low, prior 10 days), or 60 trading days |
| Dip entry | uptrend AND RSI(2) < 5. Ranked by lowest RSI(2). Up to 5 positions, idle cash only. |
| Dip exit | close > SMA5, or 10 trading days |
| Size | each position = 1/10 of the book |
| Timing | signals on the daily close, orders filled at the next official open |
| Costs | 5bp (0.05%) charged on every buy and every sell |

## The formulas

- **SMA(n)** = (C_t + C_(t-1) + ... + C_(t-n+1)) / n
- **RSI(2), Wilder**: gain_t = max(0, C_t - C_(t-1)), loss_t = max(0, C_(t-1) - C_t). AvgGain_t = (AvgGain_(t-1) + gain_t) / 2, same for loss. RSI = 100 - 100 / (1 + AvgGain / AvgLoss). Under 5 means two days of heavy, one-sided selling.
- **20-day high** = max(H_(t-20) ... H_(t-1)). **10-day low** = min(L_(t-10) ... L_(t-1)). Prior days only, so today never confirms itself.
- **20-day return** = C_t / C_(t-20) - 1
- **Adjusted prices**: signals use dividend- and split-adjusted prices (adjclose / close factor), fills use the price that actually traded.
- **Trade return (net)** = (exit x (1 - 0.0005)) / (entry x (1 + 0.0005)) - 1
- **Win rate** = trades with exit > entry / all closed trades
- **Expectancy** = average net trade return. **Profit factor** = gross net wins / gross net losses.
- **CAGR** = (E_end / E_start)^(252 / trading days) - 1
- **Sharpe** = mean(daily return) / sd(daily return) x sqrt(252)
- **Max drawdown** = max over time of (1 - E_t / peak E so far)

## What to expect (backtest, 2017-2026, 71 stocks)

| | Expected |
|---|---|
| Growth | ~27% per year (25.7% without the 10 biggest winners) |
| Sharpe | ~1.3 |
| Worst drop | about -22% at some point |
| Win rate | ~52% |
| Average win / loss | about +9.7% / -5.0% |
| Average trade after costs | about +2.6% |
| Trades | ~110 per year, about 2 a week |
| Average hold | ~19 days |

Live will be somewhat worse than the backtest. That is normal and expected. Losing weeks and months will happen; the backtest had them too. Judge it after 30+ closed trades, not 5.

**Survivorship caveat:** the stock list is today's list, which flatters every long strategy. The stress test removed the 10 biggest winners and the combo still beat buy-and-hold, which is the main reason to trust it.

## The high win-rate book (HIGHWIN)

| Rule | Definition |
|---|---|
| Entry | uptrend (close > SMA200) AND RSI(2) < 5. Ranked by lowest RSI(2). Up to 10 positions, 1/10 of the book each. |
| Exit | the first close above entry x (1 + 0.001), which covers both trading costs, or 10 trading days |

Backtest: 75.9% wins (77.0% out of sample), average win +1.9%, average loss -3.7%, +0.44% per trade after costs, profit factor 1.48, ~9.6%/yr, Sharpe 0.87, worst drop -19%, ~220 trades a year.

How a 76% win rate and modest growth go together: it banks small wins fast and occasionally holds a loser for the full 10 days. Losses are about twice the size of wins, and winning 3 out of 4 times is what keeps the average trade positive. It earns less than holding SPY (~15%/yr) over this period. It exists to prove a 75%+ win rate is achievable with a real, positive edge, not to be the main money-maker.

## How it runs

- **16:20 ET** (retries 16:35, 16:50, then every 15 min until 19:45): pull daily bars, mark the book, decide tomorrow's orders.
- **16:40 ET**: daily email includes the swing section with tomorrow's orders.
- **09:35 ET** (retries until 11:50): fill yesterday's orders at today's official open.
- Holidays: no bar for today means the market was closed, so nothing happens and orders wait.
- Every step records the day it ran, so restarts and retries never double-trade.
- Tables `swing_books` and `swing_trades` are created automatically on first start.

## Proof the live code is the tested strategy

`npm run q:parity` replays the live code (`src/swing/core.ts`) over the cached 10 years and compares it to the research result. It must print `PARITY OK` before deploying.
