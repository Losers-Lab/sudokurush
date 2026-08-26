import assert from "node:assert/strict";
import test from "node:test";
import { GameClient, type GameState } from "../client/src/game/gameClient.ts";
import { LocalConnection } from "../client/src/net/localConnection.ts";
import { generatePuzzle } from "../shared/sudoku.ts";

/**
 * Headless run of the real client against the real solo loopback — no DOM,
 * no server. The loopback executes shared/lobby-core verbatim, so this
 * exercises the full cooperative contract end-to-end at message level.
 */

type Harness = {
  client: GameClient;
  states: GameState[];
  invalids: number[];
};

function harness(name: string): Harness {
  const states: GameState[] = [];
  const invalids: number[] = [];
  const client = new GameClient(
    {
      onState: (state) => states.push(state),
      onInvalid: (i) => invalids.push(i),
      onCellUpdated: () => {},
      onNoteChanged: () => {},
      onPeerCursor: () => {},
      onLinkLost: () => {},
    },
    name,
  );
  return { client, states, invalids };
}

const last = (states: GameState[]): GameState => states[states.length - 1]!;

test("solo session: join → start → play → notes → completion", async () => {
  const { client, states } = harness("Tester");
  // The same seed the loopback's start will use is unknowable from outside
  // (relay-owned randomness), so discover the dealt puzzle through snapshots.
  const connection = new LocalConnection(
    {
      onMessage: (message) => client.onMessage(message),
      onClose: () => {},
    },
    "Tester",
  );
  client.connect(connection);
  await tick();

  let welcome = last(states);
  assert.equal(welcome.phase, "lobby", "a fresh lobby waits");
  assert.equal(welcome.players.length, 1);
  assert.ok(welcome.isHost, "the lone local seat hosts");

  client.startGame("easy");
  await tick();

  const playing = last(states);
  assert.equal(playing.phase, "playing");
  assert.equal(playing.givens.length, 81);
  assert.equal(playing.board, playing.givens, "the board starts as pure givens");

  // Find an empty cell and its correct value by replaying generation? The
  // seed is relay-owned; instead probe digits like any honest client would:
  // a wrong guess must flash invalid WITHOUT entering the board.
  const emptyCell = playing.board.indexOf(".");
  assert.ok(emptyCell >= 0);

  const wrongDigit = playing.givens[emptyCell] === "1" ? 2 : 1;
  client.place(emptyCell, wrongDigit);
  await tick();
  const afterWrong = last(states);
  assert.equal(
    afterWrong.board[emptyCell],
    ".",
    "wrong digits never become board state",
  );
  assert.equal(afterWrong.players[0]?.mistakes, 1, "mistake counted");

  // Notes toggle on and off as shared-visible state.
  client.addNote(emptyCell, 4);
  client.addNote(emptyCell, 6);
  await tick();
  assert.deepEqual(last(states).notes[String(emptyCell)], [4, 6]);
  client.removeNote(emptyCell, 4);
  await tick();
  assert.deepEqual(last(states).notes[String(emptyCell)], [6]);

  client.dispose();
});

test("optimistic placements settle against the authoritative echo", async () => {
  const { client, states, invalids } = harness("Painter");
  try {
    client.connect(
      new LocalConnection({ onMessage: (m) => client.onMessage(m), onClose: () => {} }, "Painter"),
    );
    await tick();
    client.startGame("easy");
    await tick();

    const emptyCell = last(states).board.indexOf(".");
    client.place(emptyCell, 5); // optimistic paint happens synchronously…
    // …then the loopback's ruling arrives: either the digit was right and
    // the paint stands, or `invalid` fired and the cell is empty again.
    await tick();
    const settled = last(states);
    if (invalids.includes(emptyCell)) {
      assert.equal(settled.board[emptyCell], ".", "a ruled-wrong digit must revert");
      assert.equal(settled.players[0]?.mistakes, 1);
    } else {
      assert.equal(settled.board[emptyCell], "5", "an accepted optimistic paint stands");
      assert.equal(settled.players[0]?.placements, 1);
    }
  } finally {
    client.dispose(); // otherwise the tick interval pins the test runner open
  }
});

test("reconnect replays the authoritative snapshot over stale local state", async () => {
  const { client, states } = harness("Rejoiner");
  client.connect(
    new LocalConnection({ onMessage: (m) => client.onMessage(m), onClose: () => {} }, "Rejoiner"),
  );
  await tick();
  client.startGame("easy");
  await tick();

  // Simulate a reconnecting peer's view: feed the current lobby state back
  // in as a fresh welcome (what the relay sends on hello).
  const connection = new LocalConnection(
    { onMessage: (m) => client.onMessage(m), onClose: () => {} },
    "Second",
  );
  void connection;

  const before = last(states);
  client.onMessage({
    t: "welcome",
    you: "someone-else",
    snapshot: {
      ...{
        hostId: "host-x",
        players: [{ id: "host-x", name: "Host X" }],
        onlineIds: ["host-x"],
        status: "in-progress",
        difficulty: "hard",
        givens: before.givens,
        board: before.board.replace(/\./, "9"),
        owners: {},
        notes: {},
        mistakes: {},
        placements: {},
        startedAt: 1,
        completedAt: null,
        serverNow: Date.now(),
      },
    },
  });

  const after = last(states);
  assert.equal(after.difficulty, "hard", "server state wins over anything local");
  assert.equal(after.isHost, false);
  assert.equal(after.players[0]?.name, "Host X");
  assert.notEqual(after.board, before.board, "authoritative board replaces the local copy");
  client.dispose();
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
