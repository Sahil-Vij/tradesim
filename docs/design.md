# tradesim design

A paper-trading platform for stocks and crypto. Users get virtual money, trade at real market prices with real order types, and see how their portfolio performs, without risking anything.

The product brief is NamasteDev's TradeSimulator idea. This document records how it gets built and why.

## Goals

- Trade crypto at live prices and Indian stocks at delayed prices, with market, limit, stop-loss and bracket orders.
- Never get money wrong. Every rupee and every coin is accounted for, a double click never buys twice, and two orders racing for the same cash can't both spend it.
- A UI that looks like a real trading app: candlestick charts, live portfolio value, watchlists and alerts.
- Small, reviewable changes. Each feature lands as its own pull request with tests.

## Non-goals

- Real money, real brokers or real order routing.
- Tick-perfect simulation. Fills happen at the last known price, with no slippage, spread or partial fills. The README says so.
- A mobile app, for now.

## Anti-goals

These would make the project a failure even if every feature works:

- A balance that can't be explained by the ledger.
- Floating-point money.
- A retried request that creates a second order.
- Showing a delayed price as if it were live.

## Stack

As in the brief: React with Tailwind and TradingView Lightweight Charts; Node.js with Express; PostgreSQL; Redis for prices and job queues; BullMQ for order execution; WebSockets for live updates; JWT auth with OTP as a second factor. The server is TypeScript run directly by Node 24, so there is no build step.

Market data:

- **Crypto:** Binance's public WebSocket stream for live prices, quoted in USDT and treated as USD. CoinGecko for metadata like market cap and circulating supply. CoinGecko has no free streaming feed, so it can't be the live source.
- **Stocks:** Yahoo Finance, polled and marked as delayed. Alpha Vantage's free tier allows about 25 calls a day, which is too few.

## Money

**Integers only.** Cash is stored in minor units (paise for INR, cents for USD) as `BIGINT`. Quantities are stored in units of 10⁻⁸ so fractional crypto works. Prices are minor units per whole unit. The cost of a trade is `quantity × price / 10⁸`, rounded half up, in one function with its own tests.

**Two wallets.** Stocks trade in INR and crypto in USD, as in the brief. A new user gets ₹10,00,000 and $10,000. There is no currency conversion between them.

**Double-entry ledger.** Every movement of cash or assets is a journal entry made of lines that sum to zero for each currency or asset. Buying 0.5 BTC moves dollars from the user's USD account to the house, and BTC from the house to the user's BTC account, in one entry. Balances are the sum of lines. Each account also keeps a cached balance, updated in the same transaction under a row lock (`SELECT ... FOR UPDATE`), so checking and spending a balance is one atomic step. A check constraint keeps user balances at zero or above. A test rebuilds every balance from the lines and compares.

**Holds.** A pending limit, stop or bracket order reserves its cash (or its shares, for a sell) by moving it to a hold account. Cancelling releases it, filling spends it. Pending orders can never spend the same money twice.

## Orders

- **Idempotency.** `POST /api/orders` requires an `Idempotency-Key` header. The key is unique per user. A repeat with the same key and body returns the original response; the same key with a different body is a `422`.
- **Market orders** fill straight away at the cached price, and are refused if that price is more than 10 seconds old.
- **Limit, stop-loss and bracket orders** are stored as pending. Each price tick queues a BullMQ job that finds orders whose condition is met and fills them, one transaction per order. A bracket is a parent buy plus two child sells; when one child fills, the other is cancelled in the same transaction.
- **Reset.** A user can reset their portfolio to the starting balance once every 24 hours. Pending orders are cancelled first.

## Prices and live updates

A price worker holds the Binance stream, writes the latest price for each symbol to Redis, and publishes it on a Redis channel. The WebSocket gateway relays those messages to the browser. Candles come from Binance's REST API for crypto and from Yahoo for stocks, cached in Redis.

## Testing

Server tests use `node:test` against a real Postgres, from Docker Compose locally and a service container in CI. Concurrency tests fire many orders at once and check that exactly the right ones succeed. Web tests use Vitest and Testing Library. CI runs type checks and tests on every pull request.

## Roadmap

One pull request a day, roughly in this order.

1. **Foundation:** scaffold and CI; Postgres schema and migrations; sign-up and login; the ledger and wallets; the crypto price feed; market orders with idempotency keys.
2. **Orders:** holds; limit orders and the execution worker; stop-loss; bracket orders; cancel; trade history with filters and CSV export.
3. **Interface:** dashboard; asset page with candlestick chart; buy and sell panel; watchlists; price alerts; live updates over WebSockets.
4. **Polish:** portfolio analytics; OTP second factor; delayed stock prices; portfolio reset; deployment; README with a diagram and screenshots.
5. **Later:** leaderboards and competitions, strategy backtesting, trading journal.
