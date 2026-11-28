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

**Integers only.** Cash is stored in minor units (paise for INR, cents for USD) as `BIGINT`. Quantities are stored in units of 10⁻⁸ so fractional crypto works. Prices are also stored in units of 10⁻⁸ of the currency per whole unit: cents are too coarse for a coin like DOGE, which trades near $0.06. The cost of a trade in minor units is `quantity × price / 10¹⁴`, rounded half up, in one function with its own tests.

**Two wallets.** Stocks trade in INR and crypto in USD, as in the brief. A new user gets ₹10,00,000 and $10,000. There is no currency conversion between them.

**Double-entry ledger.** Every movement of cash or assets is a journal entry made of lines that sum to zero for each currency or asset. Buying 0.5 BTC moves dollars from the user's USD account to the house, and BTC from the house to the user's BTC account, in one entry. Balances are the sum of lines. Each account also keeps a cached balance, updated in the same transaction under a row lock (`SELECT ... FOR UPDATE`), so checking and spending a balance is one atomic step. A check constraint keeps user balances at zero or above. House accounts are on the other side of every trade, so their balance is not cached: locking one row on every trade would make all trades queue behind it, and nothing is ever checked against a house balance. A test rebuilds every balance from the lines and compares.

**Holds.** A pending limit, stop or bracket order reserves its cash (or its shares, for a sell) by moving it to a hold account. Cancelling releases it, filling spends it. Pending orders can never spend the same money twice.

## Auth

Email and password. Passwords are hashed with scrypt (N=2^15, r=8, p=3, one of the OWASP-recommended settings); the parameters are stored with each hash so they can be raised later. A login for an unknown email still runs a hash, so response times don't reveal which emails have accounts.

Signing in returns a 15-minute HS256 access token, sent as `Authorization: Bearer`, and sets a 30-day refresh token in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`. The access token lives in memory in the web app, never in `localStorage`, so a script injected into the page can't read a long-lived credential.

Refresh tokens are random, stored only as a SHA-256 hash, and rotated on every use. Each sign-in starts a token family. If a token that was already rotated is presented again, someone has a copy, so the whole family is revoked and the user signs in again. OTP as a second factor comes later.

## Orders

- **Idempotency.** `POST /api/orders` requires an `Idempotency-Key` header. The key is unique per user. A repeat with the same key and body returns the original response, byte for byte, with `Idempotent-Replayed: true`; the same key with a different body is a `422`. The key is claimed with an insert at the start of the order's transaction, so a duplicate arriving at the same moment waits for the first to finish and then replays it. Only fills are saved: a failed order rolls back its key too, so a retry runs again.
- **Market orders** fill straight away at the cached price, and are refused if that price is more than 10 seconds old. The smallest order is $1, so a tiny order can't round down to a cost of zero.
- **Limit, stop-loss and bracket orders** are stored as pending. Each price tick queues a BullMQ job that finds orders whose condition is met and fills them, one transaction per order. A bracket is a limit buy with a take-profit price above its limit and a stop-loss price below it. It holds cash like a limit buy; when it fills, the coins go straight to the hold account and two child sells are created in the same transaction: a limit sell at the take profit and a stop sell at the stop loss, for the whole quantity. The two children share that one hold, which is safe because only one can fill: when one fills, the other is cancelled in the same transaction, and a child is only filled with its bracket's row locked, so two workers on two ticks can't fill both. Cancelling either child cancels both and gives the coins back once. The children are dated just after the tick that filled the bracket, so that tick can't also fire one of them, even if the buy filled below the stop. A limit order fills at the tick's price, which is its limit or better; a buy held its cost at the limit, and what the fill didn't spend goes back to cash in the same entry. A tick from before an order was placed never fills it. A stop order is a sell only (a stop-loss): it holds its coins and, once the price falls to the stop, sells at that tick's price, which can be below the stop if the price gaps down. A stop buy isn't offered, because it fills at an open-ended price and there's no amount of cash to hold for it. A limit order that could fill when it's placed waits for the next tick (about a second) rather than filling in the request. The price worker adds the jobs, one per new tick with the job id `symbol-time`, so any number of order workers can share the queue: each order is filled under a row lock with `SKIP LOCKED`, and a cancel takes the same lock, so a fill and a cancel can't both happen.
- **Reset.** A user can reset their portfolio to the starting balance once every 24 hours. Pending orders are cancelled first.

## Prices and live updates

A price worker, run as its own process, holds one Binance mini-ticker stream for all symbols, writes the latest price for each symbol to a Redis hash, and publishes it on a Redis channel. A Lua script does both and drops a tick older than the stored one. The worker reconnects with exponential backoff (1 to 30 seconds, full jitter) when the socket closes or sends nothing for 30 seconds; Binance also closes every connection after 24 hours. `GET /api/prices` returns each price with its age and marks it stale after 10 seconds. The WebSocket gateway relays those messages to the browser. Candles come from Binance's REST API for crypto and from Yahoo for stocks, cached in Redis.

## Testing

Server tests use `node:test` against a real Postgres, from Docker Compose locally and a service container in CI. Concurrency tests fire many orders at once and check that exactly the right ones succeed. Web tests use Vitest and Testing Library. CI runs type checks and tests on every pull request.

## Roadmap

One pull request a day, roughly in this order.

1. **Foundation:** scaffold and CI; Postgres schema and migrations; sign-up and login; the ledger and wallets; the crypto price feed; market orders with idempotency keys.
2. **Orders:** holds; limit orders and the execution worker; stop-loss; bracket orders; cancel; trade history with filters and CSV export.
3. **Interface:** dashboard; asset page with candlestick chart; buy and sell panel; watchlists; price alerts; live updates over WebSockets.
4. **Polish:** portfolio analytics; OTP second factor; delayed stock prices; portfolio reset; deployment; README with a diagram and screenshots.
5. **Later:** leaderboards and competitions, strategy backtesting, trading journal.
