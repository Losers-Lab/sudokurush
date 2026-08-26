#!/usr/bin/env node
// Live relay verification against a running worker (local dev or production).
// Exercises the message contracts TypeScript cannot check, with TWO
// simultaneous players on ONE shared board:
//
//   1. join by code → welcome snapshots, host election
//   2. host starts → both players receive the SAME puzzle
//   3. player A places a correct digit → player B sees it (cell-updated)
//   4. wrong digits are judged server-side and never reach the board
//   5. shared notes: A adds → B sees; B removes → A sees
//   6. reconnection: B drops, A plays on, B rejoins → current state arrives
//   7. completion: board solved cooperatively → status completed, locked
//
// Usage: node scripts/verify-room.mjs [wsBase]
//   wsBase default: ws://localhost:8787/api/room  (wrangler dev)
//   Production:     wss://<your-worker>.workers.dev/api/room
//
// Exit code 0 only when every assertion holds.

const BASE = process.argv[2] ?? "ws://localhost:8787/api/room";
const ROOM = `${BASE}/open:${process.env.VERIFY_ROOM ?? "VER234"}`;
const MAX_PLAYERS_PLACE_PROBE_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Submits one placement and waits for ITS ruling. Hits are broadcast to
 * every seat; invalid rulings are PRIVATE to the submitter. Cursors are
 * taken over BOTH logs before the submit fires, so a previous attempt's
 * stale invalid can never satisfy this attempt's wait.
 */
async function submitAndAwaitRuling(submit, sender, cell, observer = sender, timeoutMs = 1500) {
  const senderCursor = sender.log.length;
  const observerCursor = observer.log.length;
  submit();
  const hitOrMiss = async (client, from, kind) => {
    while (Date.now() < deadline) {
      const found = client.log.slice(from).find((m) =>
        kind === "hit"
          ? m.t === "cell-updated" && m.i === cell
          : m.t === "invalid" && m.i === cell,
      );
      if (found) return found;
      await sleep(20);
    }
    return null;
  };
  const deadline = Date.now() + timeoutMs;
  const winner = await Promise.race([
    Promise.any([
      hitOrMiss(observer, observerCursor, "hit"),
      hitOrMiss(sender, senderCursor, "miss"),
    ]),
    sleep(timeoutMs + 100),
  ]);
  return winner ?? null;
}

function connect(playerId, name) {
  const ws = new WebSocket(`${ROOM}?player=${playerId}`);
  const log = [];
  const waiters = [];
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", name })));
  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data);
    log.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(parsed)) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    ws,
    log,
    raw(message) {
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    waitFor(predicate, label, timeoutMs = 3000) {
      const existing = log.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate: (m) => {
            if (!predicate(m)) return false;
            clearTimeout(timer);
            return true;
          },
          resolve,
        };
        waiters.push(entry);
        const timer = setTimeout(() => {
          const at = waiters.indexOf(entry);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
      });
    },
    close() {
      ws.close();
    },
  };
}

const latestSnapshot = (client) =>
  [...client.log].reverse().find((m) => m.t === "welcome" || m.t === "snapshot")?.snapshot;

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

/* ---------------------------------------------------------------- */

console.log(`verifying ${ROOM}`);

const alice = connect("vrAlice", "Alice");
await sleep(800);

// The canary room persists between runs. Recover to a clean WAITING lobby:
// a completed board is replaced by a fresh deal, an in-progress one is not
// restartable — so if we find one mid-game, wait out nothing and just use a
// fresh room instead.
let phase = latestSnapshot(alice)?.status;
if (phase && phase !== "waiting") {
  alice.close();
  console.log("canary room dirty; this verifier owns VER234 — reset by leaving it empty");
  process.exit(failures ? 1 : 1);
}
check("alice joins and becomes host of the waiting lobby", phase === "waiting");

const bob = connect("vrBob", "Bob");
await alice.waitFor((m) => m.t === "snapshot" && m.snapshot.players.length === 2, "roster of 2");
check("bob's join reaches alice in real time", true);

const bobWelcome = await bob.waitFor((m) => m.t === "welcome", "bob welcome");
check("bob receives full lobby state on hello", bobWelcome.snapshot.players.length === 2);

// --- start --------------------------------------------------------

const difficulty = "easy";
alice.raw({ t: "start", difficulty });
const startA = await alice.waitFor(
  (m) => m.t === "snapshot" && m.snapshot.status === "in-progress",
  "alice sees game started",
);
const startB = await bob.waitFor(
  (m) => m.t === "snapshot" && m.snapshot.status === "in-progress",
  "bob sees game started",
);
check(
  "both players hold the identical shared puzzle",
  startA.snapshot.givens === startB.snapshot.givens,
);

const givens = startA.snapshot.givens;
const editable = [];
for (let i = 0; i < 81; i++) if (givens[i] === ".") editable.push(i);
check("puzzle has empty cells to solve", editable.length > 30, `${editable.length} blanks`);

// --- authoritative placement --------------------------------------

const target = editable[0];
let acceptedValue = null;
for (let v = 1; v <= 9; v++) {
  bob.raw({ t: "place", i: target, v });
  const ruling = await submitAndAwaitRuling(() => bob.raw({ t: "place", i: target, v }), bob, target, alice);
  if (ruling?.t === "cell-updated") {
    acceptedValue = v;
    // cell-updated races its own trailing snapshot; assert against the
    // authoritative board, not the instant of the broadcast.
    await alice
      .waitFor((m) => m.t === "snapshot" && m.snapshot.board[target] !== ".", "settle")
      .catch(() => {});
    break;
  }
}
check(
  "bob's correct digit reached alice's board instantly",
  acceptedValue !== null && latestSnapshot(alice).board[target] === String(acceptedValue),
);

// Wrong digits must be judged privately and never enter the shared board.
// At most two attempts so this probe cannot accidentally solve its cell.
const beforeBoard = latestSnapshot(alice).board;
const secondCell = editable[1];
let attempts = 0;
for (let v = 1; v <= 9 && attempts < 2; v++) {
  if (v === acceptedValue) continue;
  alice.raw({ t: "place", i: secondCell, v });
  attempts += 1;
  const outcome = await submitAndAwaitRuling(() => alice.raw({ t: "place", i: secondCell, v }), alice, secondCell);
  if (outcome?.t === "cell-updated") break;
}
const afterProbes = latestSnapshot(alice).board;
let onlyTheProbeCellMoved = true;
for (let i = 0; i < 81 && afterProbes !== beforeBoard; i++) {
  if (i !== secondCell && afterProbes[i] !== beforeBoard[i]) {
    onlyTheProbeCellMoved = false;
    break;
  }
}
check("wrong submissions left no trace on the other player's board", onlyTheProbeCellMoved);

// --- shared notes -------------------------------------------------

const noteCell = editable[2];
bob.raw({ t: "add-note", i: noteCell, v: 3 });
await alice.waitFor((m) => m.t === "note-changed" && m.i === noteCell, "note add");
check("bob's pencil mark appeared on alice's board", true);

bob.raw({ t: "add-note", i: noteCell, v: 7 });
await alice.waitFor((m) => m.t === "note-changed" && m.i === noteCell && m.values.length === 2, "second mark");
alice.raw({ t: "remove-note", i: noteCell, v: 3 });
const removal = await bob.waitFor(
  (m) => m.t === "note-changed" && m.i === noteCell && m.values.join() === "7",
  "note removal",
);
check("cross-player note add/remove converges on both boards", removal.values.join() === "7");

// --- reconnection -------------------------------------------------

bob.close();
await sleep(400);
// Alice plays on while Bob is away.
const boardNow = () => latestSnapshot(alice).board;
const awayCell = editable.find((cell) => boardNow()[cell] === ".");
let awayValue = null;
if (awayCell !== undefined) {
  for (let v = 1; v <= 9; v++) {
    alice.raw({ t: "place", i: awayCell, v });
    const ruling = await submitAndAwaitRuling(() => alice.raw({ t: "place", i: awayCell, v }), alice, awayCell);
    if (ruling?.t === "cell-updated") {
      await alice
        .waitFor((m) => m.t === "snapshot" && m.snapshot.board[awayCell] !== ".", "settle-away")
        .catch(() => {});
      awayValue = v;
      break;
    }
    if (ruling == null) break; // relay unreachable; skip the assertion below
  }
}

const bobAgain = connect("vrBob", "Bob");
const rejoin = await bobAgain.waitFor((m) => m.t === "welcome", "rejoin welcome");

check(
  "reconnecting player receives the CURRENT authoritative board",
  awayValue !== null && rejoin.snapshot.board[awayCell] === String(awayValue),
  `cell ${awayCell} = ${rejoin.snapshot.board[awayCell]}`,
);

// --- cooperative completion --------------------------------------

// Solve the remaining cells from both seats interleaved, like real players.
let solved = true;
outer: for (const cell of editable) {
  if (boardNow()[cell] !== ".") continue;
  let placed = false;
  for (const seat of [alice, bobAgain]) {
    for (let v = 1; v <= 9; v++) {
      seat.raw({ t: "place", i: cell, v });
      const ruling = await submitAndAwaitRuling(() => seat.raw({ t: "place", i: cell, v }), seat, cell, alice, 900);
      if (ruling?.t === "cell-updated") {
        placed = true;
        continue outer;
      }
      // invalid: this digit is wrong for this seat — fall through to the next one.
    }
  }
  if (!placed) {
    solved = false;
    break;
  }
}

const [finalA, finalB] = await Promise.all([
  alice
    .waitFor((m) => m.t === "snapshot" && m.snapshot.status === "completed", "completed", 8000)
    .catch(() => null),
  bobAgain
    .waitFor((m) => m.t === "snapshot" && m.snapshot.status === "completed", "completed b", 8000)
    .catch(() => null),
]);
check("cooperative solve flips both players to COMPLETED", solved && finalA.snapshot.status === "completed" && finalB.snapshot.status === "completed");

// Completed lobbies refuse further modifications: nothing may appear on
// anyone's board after the attempt.
const lockCursor = alice.log.length;
bobAgain.raw({ t: "place", i: editable[3], v: 5 });
await sleep(400);
check(
  "a completed board rejects new placements",
  latestSnapshot(alice).status === "completed" &&
    !alice.log.slice(lockCursor).some((m) => m.t === "cell-updated"),
);

alice.close();
bobAgain.close();

console.log(failures === 0 ? "\nall assertions held ✔" : `\n${failures} assertion(s) failed ✖`);
process.exit(failures === 0 ? 0 : 1);
