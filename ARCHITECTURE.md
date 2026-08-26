# SudokuRush architecture

One cooperative sudoku game: a static client, a Worker, and two Durable
Object classes. The defining constraint is **server authority over one
shared board** — this doc explains where every guarantee lives.

## Topology

```
browser / Discord activity
  │  static assets (client/dist) + /api/*
  ▼
Worker ──► GameRoom DO        one per lobby; THE shared game state
  │         │  hibernating WebSockets, storage-backed state,
  │         │  server-only solution, alarm-driven hygiene
  │         ▼
  │       RoomBroker DO       singleton; live-lobby registry, capacity gate
  ▼
LIMITS_KV (optional)          capacity override without redeploy
```

## The single source of truth

`shared/lobby-core.ts` holds every rule that decides what happens next:
placement judgment, note eligibility, host election/handoff, roster caps,
status transitions, snapshot projection. Functions are pure — state in,
effects out, no clock reads (callers stamp time). Consequences:

- **Determinism under races.** The DO applies client proposals serially in
  arrival order; the pure functions define what each arrival does. Two
  players racing one cell resolve by arrival: first correct digit claims it,
  later proposals see `cell-taken`. Unit tests pin both orderings.
- **Solo == multiplayer by construction.** The browser's solo-practice
  loopback (`client/src/net/localConnection.ts`) imports `shared/lobby-core`
  verbatim instead of re-implementing it. Practice cannot drift from the
  real rules.
- **The DO shell stays thin.** `worker/src/room.ts` only hydrates storage,
  dispatches messages to core functions, persists on mutation, and fans out
  effects as wire messages.

## Anti-cheat posture

The puzzle's solution lives ONLY inside the GameRoom's persisted state.
`buildSnapshot` is the single sanctioned path from game state to the
network, and it cannot emit the solution — snapshots carry givens, accepted
placements, owners, notes, counters. Wrong digits are never applied and
never broadcast: the submitter alone receives `{t:"invalid", i}` while
everyone else just gets a mistake-counter update via snapshot. A hostile
client can only waste its own time.

## Lobby lifecycle

`waiting → in-progress → completed`, driven by the host's single `start`
verb (from `completed` it deals a fresh puzzle — play again). There is no
transient STARTING status: the start broadcast is atomic within the DO, so
an intermediate state would be unobservable. Completion is detected
server-side after each placement (`cells.every(non-zero)`), stamps
`completedAt`, locks the board against placements and notes, and shows
everyone the same contribution table.

## Realtime model

Events for play, snapshots for truth:

- `{t:"cell-updated"}` / `{t:"note-changed"}` paint instantly; each is
  followed by an authoritative snapshot so derived panels (placements,
  mistakes, online set) reconcile without clients computing anything.
- Selection sharing (`cursor`) is pure relay traffic — throttled at 150ms
  per seat, never stored, sender-excluded, skipped entirely with no
  audience or in solo.
- Full state syncs happen on hello (welcome) — join AND reconnect are the
  same code path, and a returning player reclaims their seat by stable id
  (Discord user id, or a localStorage guest UUID).

## Free-tier cost accounting

| Cost              | Driver                        | Mitigation |
| ----------------- | ----------------------------- | ---------- |
| DO requests       | every handled WS message      | pings answered by `setWebSocketAutoResponse` (free); cursors floored at 150ms and dropped without an audience; burst bucket (25/s) caps hostile floods |
| DO duration       | wall-clock while awake        | hibernation: idle sockets cost nothing between messages |
| Storage writes    | one blob put per mutation     | mutations are player-paced (digits, notes); no-op note toggles skip writes; broker heartbeats coalesce |
| Alarms            | occupied lobbies, ~10 min     | doubles as ghost-seat sweep + broker heartbeat |

## What breaks first

1. **DO request volume** across many simultaneous lobbies — mitigations
   above; the broker's capacity gate is the circuit breaker.
2. **Ghost seats** holding the 8-seat cap — swept after 5 minutes of
   silence (shorter than a competitive game needs; a swept player rejoins
   into full current state anyway). Contributions already on the board stay
   attributed when someone leaves mid-game.
3. **Snapshot size** — bounded by 81 cells plus small maps; irrelevant at
   8 players.

## Module seams

- `shared/protocol.ts` — the wire contract; both sides import it. Solution
  fields simply do not exist in any outbound type.
- `shared/lobby-core.ts` — authoritative rules + solution-free snapshot
  projection (see above).
- `shared/sudoku.ts` — seeded generator with uniqueness-guaranteed hole
  digging; deterministic per seed, which makes tests exact.
- `worker/src/ghost-sweep.ts` — pure eviction/stamp decisions, unit-tested
  without a DO runtime.
- `worker/src/broker.ts` + `capacity.ts` — admission gate; fails open on
  its own outage so the gate can never take live games down.
- Client split: `game/gameClient.ts` (state machine; renders rulings,
  never renders verdicts of its own), `board/boardView.ts` (pure
  presentation), `net/*` (transport behind one interface).
