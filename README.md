# tradesim

Paper trading for stocks and crypto. Start with virtual money, trade at real market prices with market, limit, stop-loss and bracket orders, and track how your portfolio does, without risking a rupee.

## Status

Early and under active development. The plan and the reasoning behind it are in [docs/design.md](docs/design.md).

| Feature | State |
| --- | --- |
| Server, web app and CI | Done |
| Postgres schema and migrations | Next |
| Sign-up and login | Planned |
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
npm run dev              # API on http://localhost:4000
npm run dev:web          # app on http://localhost:5173, proxies /api to the server
```

## Stack

React, Tailwind and TradingView Lightweight Charts on the front end. Node.js with Express, PostgreSQL, Redis and BullMQ on the back end. The server is TypeScript run directly by Node, so there is no build step.

## Development

```sh
npm test
npm run typecheck
```

## License

MIT
