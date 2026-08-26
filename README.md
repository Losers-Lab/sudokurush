# SudokuRush

**One shared sudoku board, solved together in real time.** Everyone in a lobby
sees the exact same puzzle; every correct digit, pencil mark, and selection
appears on all boards instantly. The server is the single source of truth —
clients propose moves, the relay judges them against the solution and
broadcasts the outcome.

Playable as a Discord Activity or standalone in the browser via share codes.

## Stack

| Layer      | Tech                                                          |
| ---------- | ------------------------------------------------------------- |
| Client     | Vite + plain TypeScript, no framework                         |
| Realtime   | WebSockets over Cloudflare Durable Objects (SQLite-backed)    |
| Backend    | Cloudflare Worker — static assets + `/api/*`                  |
| Shared     | Plain TS modules imported by both sides (wire contract, rules)|
| Tests      | Node's built-in test runner on raw `.ts` files                |
| Dev env    | Docker Compose (nothing installed but Docker)                 |
| Identity   | Discord OAuth (`identify`, `guilds.members.read`) or guest    |

## Repository layout

```
client/     Vite app: board UI, net layer, screens, theme
worker/     Cloudflare Worker + Durable Objects (lobby relay, broker)
shared/     Wire protocol + THE authoritative rules module
tests/      node --test suites (rules engine, client loopback, sweep)
scripts/    verify-room.mjs live multiplayer verification
assets/     static assets served verbatim (brand art, _headers)
```

## Run it

### Docker (recommended — only Docker required)

```sh
cp example.env .env          # optional; only Discord sign-in needs values
docker compose up --build    # serves http://localhost:8787
```

The compose file runs `vite build --watch` beside `wrangler dev`, so client
edits rebuild live. A second container exposes a throwaway
`trycloudflare.com` URL for testing from phones.

### Native

```sh
npm run install:all
npm --prefix client run build
npm --prefix worker run dev  # http://localhost:8787
```

## Deploy to Cloudflare

```sh
npx wrangler login           # once per machine
npm run deploy               # builds client, deploys worker + assets
```

`worker/wrangler.jsonc` defaults `OPEN_ROOMS` to true so browser players can
create/join code rooms. For Discord Activity play, fill `DISCORD_CLIENT_ID`,
`wrangler secret put DISCORD_CLIENT_SECRET`, and configure the activity in
the [Discord Developer Portal](https://discord.com/developers/applications).

## Verify a deployment

```sh
node scripts/verify-room.mjs ws://localhost:8787/api/room        # local
node scripts/verify-room.mjs wss://<your-worker>.workers.dev/api/room
```

Twelve assertions across two simultaneous players: identical dealt puzzle,
instant cross-board placements, private wrong-answer rulings, shared notes,
reconnect-to-current-state, cooperative completion, completed-board lock.

## Commands

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Docker dev environment                        |
| `npm test`          | Unit tests (29) over rules, client, sweep     |
| `npm run verify:room` | Live two-player protocol verification       |
| `npm run deploy`    | Build + deploy to Cloudflare Workers          |

## How authority works

See [ARCHITECTURE.md](ARCHITECTURE.md). Short version: one `GameRoom`
Durable Object per lobby holds the board **and its solution**; every
placement is judged server-side (wrong digits never reach the shared state
and are reported only to their submitter); snapshots are solution-free by
construction; the same pure rules module powers solo practice in the
browser, so the semantics cannot drift.
