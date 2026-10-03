# Troy Quant

How Troy gets better from here: measure first, change second, and only ship what survives data it was not tuned on.

## The loop

1. `npm run q:fetch` pulls ~30 days of real 1-minute bars for Troy's full universe into `quant/data/`.
2. `npm run q:research` asks the market what actually predicts the next 15, 30 and 60 minutes. No Troy rules involved.
3. `npm run q:backtest` replays the real deployed engine over those 30 days and scores it.
4. Change one thing with `--set` or `--sweep`, rerun, compare. Keep it only if it wins after costs in both halves.
5. Ship it. The daily email scorecard is the live check that the backtest was honest.

```
npm run q:backtest -- --set SS55_BENCH_PCT=-0.003
npm run q:backtest -- --sweep SS59_FLOOR_PCT=0.003,0.006,0.01
npm run q:backtest -- --set RSI_BOUNCE_ENABLED=true --trades
```

`--set` takes any `export const` in `rules.ts`. Settings (budget, modes) live in `quant/backtest.config.json`.

## The formulas

**Return.** r = P1 / P0 - 1. In basis points: r x 10,000 (1bp = 0.01%). Log return ln(P1/P0) adds across time, which is why volatility math uses it.

**Volatility.** Standard deviation of returns. Scale with the square root of time: daily vol = 1-min vol x sqrt(390), annual = daily x sqrt(252). A stock with 2% daily vol moves about 0.1% per minute, so one standard deviation reaches 0.30% in about 9 minutes (0.1% x sqrt(9)). A -0.30% stop is routine noise, not a signal. That is why Troy's stops get hit by noise.

**VWAP.** sum(price x volume) / sum(volume) since the open. The average price everyone paid today. Institutions benchmark against it, so price above VWAP means buyers are in control on the day.

**EMA.** EMA_t = k x P_t + (1 - k) x EMA_(t-1), with k = 2 / (n + 1). Weights recent prices more. EMA5 above EMA20 is a short-term uptrend.

**RSI.** 100 - 100 / (1 + avgGain / avgLoss) over n bars. Above 70 is stretched up, below 30 stretched down. On 1-minute bars it is mostly measuring the last 14 minutes of noise.

**ATR.** Average absolute bar-to-bar move. Stops and targets should be sized in ATRs, not fixed percents, so a quiet stock and a wild one get the same treatment.

**Relative volume (RVOL).** Recent volume per minute / today's average per minute. Above 1 means activity is picking up. Volume confirms moves; price moving on no volume usually fades.

**Opening range.** High and low of the first 30 minutes. A break above it with volume is the classic intraday momentum entry (Troy's SS38).

**Information Coefficient (IC).** Spearman rank correlation between a signal and the forward return across all stocks at one moment. Real intraday signals have IC around 0.02 to 0.05. That sounds tiny and it is enough. Averaged per day and t-tested: t = mean / (sd / sqrt(days)). Bar for "real": |t| >= 3 and the same sign in the first 60% and the last 40% of days.

**Quintile spread.** Sort stocks into fifths by the signal. Q5 - Q1 is what the signal separates, in bp. A long-only bot needs Q5 after costs > 0.

**Expectancy.** E = p x W - (1 - p) x L, with p the win rate, W the average win, L the average loss. This is the only number that says whether a strategy makes money. Everything else explains why.

**Break-even win rate.** p* = L / (W + L) = 1 / (1 + payoff), with payoff = W / L. Win 2x what you lose and you only need 33% wins. Win 0.1x what you lose and you need 91%.

**Profit factor.** Gross wins / gross losses. Below 1 loses money. 1.3 is decent, above 2 is rare and usually means too few trades.

**Sharpe.** mean daily return / sd of daily return x sqrt(252). Return per unit of risk. Above 1 is good, above 2 is excellent, above 3 on 30 days is almost always luck or a bug.

**Max drawdown.** Largest drop from a peak in account value. What it feels like to run the strategy.

**Kelly.** f* = p - (1 - p) / payoff. The bet size that grows money fastest. Real desks use half of it or less, because p and payoff are estimates.

**Costs.** 5bp per side assumed (spread + slippage on liquid large caps), 10bp round trip. A strategy that trades 12 times a day needs more than 10bp of real edge per trade just to break even.

**Win-rate uncertainty.** Standard error = sqrt(p x (1 - p) / n). Troy's first 5 live trades went 1 for 5 (20%), with a standard error of 18 points, so the true rate could be anywhere from about 0% to 55%. You need ~100 trades for +/-5 points.

## The 90% question, honestly

Win rate is mostly set by where the exits sit, not by skill. On a random walk, the chance of hitting the target before the stop is about SL / (TP + SL). Put the stop at 9x the target and you win about 90% of the time with zero skill. And expectancy is still zero before costs, negative after.

So a 90% win rate is easy to build and almost never profitable. The research script's TP/SL grid shows this on real data: the cells that reach 90% and what they earn per trade.

The goals that actually mean "Troy is good":

1. Expectancy after costs > 0, in both halves of the backtest
2. Profit factor > 1.3
3. Sharpe > 1.5
4. Holds on the live scorecard for 100+ trades

If you also want a high win rate, it can be pushed up with exits, as long as expectancy stays positive. The grid tells you exactly how much each point of win rate costs.

## How to read the market (what the research measures)

**Most of a stock's move is the market.** Large caps move with SPY. That is why Troy checks regime and relative strength first, and why the IC is measured across stocks at the same moment, which strips the market out.

**Momentum vs reversion.** Over minutes to hours, stocks that are strong often keep going (positive IC on momentum features), but over the very shortest windows they often snap back (negative IC). Which one holds, and at which horizon, is a measured fact for this universe, not an opinion. The research output tells you.

**Time of day.** Volume and volatility are U-shaped: high at the open, quiet at lunch, rising into the close. The open has the most movement to beat costs and the most noise. Lunch is where trades go nowhere, which is exactly when Troy's SS55 time-outs fire.

**Volume confirms.** Breakouts on high relative volume follow through more often. Breakouts on thin volume fade. The SS62 gate exists for this, but it is measured here to see if it is too strict.

**VWAP is the anchor.** Above VWAP and holding is strength. Lost VWAP is a common exit trigger.

## Discipline

* **Out of sample or it didn't happen.** Every result is reported for both halves. Tune on one, confirm on the other.
* **Multiple testing.** Run 40 tests and 2 will look significant by chance. Prefer ideas with a reason behind them and |t| >= 3.
* **Stable neighbors.** If SS59 at 0.6% is great but 0.5% and 0.7% are bad, it is noise. Real edges are smooth.
* **Research must match production.** The backtest steps once a minute. Live ticks every 10 seconds, so every "N bars" rule sees a shorter window live. The next structural fix is making live bars 1-minute candles so the two are the same.
* **Small samples lie.** 30 days kills bad ideas. It cannot prove a good one. Longer history (paid data) is the next upgrade if the first results are promising.
