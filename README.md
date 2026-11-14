# tradesim

Paper trading for stocks and crypto. Start with virtual money, trade at real market prices with market, limit, stop-loss and bracket orders, and track how your portfolio does, without risking a rupee.

## Status

Early and under active development. The plan and the reasoning behind it are in [docs/design.md](docs/design.md).

| Feature | State |
| --- | --- |
| Server, web app and CI | Done |
| Postgres schema and migrations | Done |
| Sign-up and login | Next |
| Double-entry ledger and wallets | Planned |
| Live crypto prices | Planned |
| Market orders with idempotency keys | Planned |
| Limit, stop-loss and bracket orders | Planned |
| Dashboard, charts, watchlists and alerts | Planned |

## Run it

Requires Node 24+ and Docker.

```sh
npm install
cp .env.example .env
docker compose up -d     # Postgres and Redis
npm run migrate          # create or update the tables
npm run dev              # API on http://localhost:4000
npm run dev:web          # app on http://localhost:5173, proxies /api to the server
```

## Stack

React, Tailwind and TradingView Lightweight Charts on the front end. Node.js with Express, PostgreSQL, Redis and BullMQ on the back end. The server is TypeScript run directly by Node, so there is no build step.

## Development

```sh
npm test         # database tests need Postgres from docker compose
npm run typecheck
```

Schema changes go in a new file in `server/migrations`, named like `002_short_name.sql`. Each one runs once, in its own transaction. The runner refuses to start if an applied migration has been edited, so fix mistakes with a new migration.

## The ledger

Money and assets only move through journal entries, and the database enforces the rules itself, so a bug in the app can't break them:

- Every entry balances: for each asset, its lines sum to zero. This is checked when the transaction commits.
- Entries and lines are append-only. Updates and deletes are rejected, and mistakes are fixed with a reversing entry.
- A line can't carry a different asset from its account.
- A user's balance can never go below zero.
- Amounts are whole numbers of the smallest unit (paise, cents, or 10⁻⁸ of a coin), and the server reads them as `BigInt`, never as floating point.

## License

MIT
