import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHello,
  applyLeave,
  applyNote,
  applyStart,
  buildSnapshot,
  createLobby,
  judgePlacement,
  resolveMaxPlayers,
  type LobbyState,
} from "../shared/lobby-core.ts";
import { generatePuzzle } from "../shared/sudoku.ts";

const NOW = 1_700_000_000_000;

function lobby(): LobbyState {
  return createLobby("medium");
}

/** Joins `ids` in order; the first becomes host. */
function joined(ids: string[], maxPlayers = 8): LobbyState {
  const state = lobby();
  for (const id of ids) {
    const result = applyHello(state, id, `Name-${id}`, null, NOW, maxPlayers);
    assert.ok(result.ok);
  }
  return state;
}

/** Starts a game and returns the state plus the puzzle's server-side solution. */
function playing(ids: string[], seed = 99) {
  const state = joined(ids);
  const start = applyStart(state, ids[0]!, "easy", seed, NOW);
  assert.ok(start.ok);
  const puzzle = generatePuzzle("easy", seed);
  return { state, solution: puzzle.solution, givens: puzzle.givens };
}

/** First empty, non-given cell index of the puzzle. */
function firstEditableCell(givens: readonly number[]): number {
  return givens.findIndex((value) => value === 0);
}

test("lobby lifecycle: join, duplicate hello, leave, host handoff", () => {
  const state = joined(["a", "b"]);
  assert.equal(state.hostId, "a");

  // Duplicate hello is a rename/rejoin, never a second seat.
  applyHello(state, "a", "Renamed", null, NOW + 1, 8);
  assert.equal(state.players.length, 2);
  assert.equal(state.players[0]?.name, "Renamed");

  // Host leaves → crown moves to the next seat in roster order.
  const newHost = applyLeave(state, "a");
  assert.equal(newHost, "b");
  assert.equal(state.hostId, "b");

  // Last departure empties the lobby entirely.
  applyLeave(state, "b");
  assert.equal(state.players.length, 0);
  assert.equal(state.hostId, null);
});

test("roster cap is enforced with a clear reason, configurable", () => {
  const state = joined(["p1", "p2"], 2);
  const overflow = applyHello(state, "p3", "Third", null, NOW, 2);
  assert.deepEqual(overflow, { ok: false, reason: "lobby-full" });
  // Returning players always pass — reconnection depends on it.
  const returning = applyHello(state, "p1", "p1", null, NOW + 1, 2);
  assert.ok(returning.ok);

  assert.equal(resolveMaxPlayers(undefined), 8);
  assert.equal(resolveMaxPlayers("12"), 12);
  assert.equal(resolveMaxPlayers("garbage"), 8);
  assert.equal(resolveMaxPlayers("-3"), 1);
  assert.equal(resolveMaxPlayers("9999"), 30, "hard ceiling against misconfiguration");
});

test("start deals one shared puzzle; only the host can deal", () => {
  const state = joined(["host", "guest"]);
  const refused = applyStart(state, "guest", "easy", 5, NOW);
  assert.deepEqual(refused, { ok: false, reason: "not-host" });

  assert.ok(applyStart(state, "host", "easy", 5, NOW).ok);
  assert.equal(state.status, "in-progress");
  const dealtGivens = [...state.givens];

  // Restart mid-game is refused: no silent board wipes.
  assert.deepEqual(applyStart(state, "host", "easy", 6, NOW), {
    ok: false,
    reason: "game-in-progress",
  });
  assert.deepEqual(state.givens, dealtGivens, "refused start must not touch the board");

  // Same seed → same puzzle; every client receives this exact grid.
  const twin = joined(["x"]);
  applyStart(twin, "x", "easy", 5, NOW);
  assert.deepEqual(twin.givens, dealtGivens);
});

test("correct placements are applied and attributed", () => {
  const { state, solution, givens } = playing(["a", "b"]);
  const i = firstEditableCell(givens);
  const v = solution[i]!;

  const judged = judgePlacement(state, "b", i, v, NOW + 5);
  assert.equal(judged.verdict, "accepted");
  if (judged.verdict !== "accepted") throw new Error("unreachable");
  assert.equal(state.cells[i], v);
  assert.equal(state.owners.get(i), "b", "the cell remembers who placed it");
  assert.equal(state.placements["b"], 1);
  assert.equal(judged.solved, false);
});

test("incorrect placements never touch the shared board", () => {
  const { state, solution, givens } = playing(["a"]);
  const i = firstEditableCell(givens);
  const wrong = (solution[i]! % 9) + 1;

  const judged = judgePlacement(state, "a", i, wrong, NOW + 5);
  assert.deepEqual(judged, { verdict: "incorrect", i });
  assert.equal(state.cells[i], 0, "board unchanged");
  assert.equal(state.owners.has(i), false);
  assert.equal(state.mistakes["a"], 1, "mistake recorded server-side");

  // The right answer still works after a miss.
  judgePlacement(state, "a", i, solution[i]!, NOW + 6);
  assert.equal(state.cells[i], solution[i]);
  assert.equal(state.mistakes["a"], 1);
});

test("original cells are immutable and filled cells cannot be overwritten", () => {
  const { state, solution, givens } = playing(["a"]);
  const givenIndex = givens.findIndex((v) => v !== 0);
  assert.deepEqual(judgePlacement(state, "a", givenIndex, 5, NOW), {
    verdict: "rejected",
    reason: "given-cell",
    i: givenIndex,
  });

  const empty = firstEditableCell(givens);
  judgePlacement(state, "a", empty, solution[empty]!, NOW + 1);
  assert.equal(
    judgePlacement(state, "b" in state ? "b" : "a", empty, solution[empty]!, NOW + 2).verdict,
    "rejected",
  );
  assert.deepEqual(judgePlacement(state, "a", empty, 9, NOW + 2), {
    verdict: "rejected",
    reason: "cell-taken",
    i: empty,
  });
});

test("invalid input is rejected without state changes", () => {
  const { state, givens } = playing(["a"]);
  const i = firstEditableCell(givens);
  assert.match((judgePlacement(state, "a", 81, 1, NOW) as { reason: string }).reason, /invalid-cell|game-not-started|game-completed/);
  assert.equal(judgePlacement(state, "a", -1, 1, NOW).verdict, "rejected");
  assert.equal(judgePlacement(state, "a", i, 0, NOW).verdict, "rejected");
  assert.equal(judgePlacement(state, "a", i, 10, NOW).verdict, "rejected");
  assert.equal(judgePlacement(state, "a", 1.5, 1, NOW).verdict, "rejected");
  assert.ok(Object.keys(state.mistakes).length === 0, "malformed input costs no mistakes");
});

test("placements before start and after completion are refused", () => {
  const waiting = joined(["a"]);
  assert.deepEqual(judgePlacement(waiting, "a", 0, 1, NOW), {
    verdict: "rejected",
    reason: "game-not-started",
  });

  const { state, solution, givens } = playing(["a", "b"]);
  // Fill every editable cell to force completion.
  for (let i = 0; i < 81; i++) {
    if (givens[i] === 0) {
      const judged = judgePlacement(state, i % 2 === 0 ? "a" : "b", i, solution[i]!, NOW + i);
      assert.equal(judged.verdict, "accepted");
      if (judged.verdict === "accepted" && i < 80) {
        // not done yet unless last
      }
    }
  }
  assert.equal(state.status, "completed");
  assert.ok(state.completedAt !== null);
  // Completion locks the board.
  const leftover = state.cells.findIndex((cell, index) => cell === 0);
  assert.equal(leftover, -1, "solved means no empty cells remain");
  assert.equal(judgePlacement(state, "a", 0, solution[0]!, NOW + 999).verdict, "rejected");
  assert.deepEqual(applyNote(state, "a", "add", 40, 3), {
    verdict: "rejected",
    reason: "game-completed",
  });
  // And the host cannot silently wipe a completed board via start-refusal path.
  assert.ok(applyStart(state, "a", "hard", 11, NOW + 1000).ok, "completed boards can be replaced by a fresh deal");
  assert.equal(state.status, "in-progress");
});

test("shared notes: add, remove, multiple marks, multiple players", () => {
  const { state, givens } = playing(["a", "b"]);
  const i = firstEditableCell(givens);

  const added = applyNote(state, "a", "add", i, 3);
  assert.equal(added.verdict, "applied");
  if (added.verdict === "applied") assert.deepEqual(added.values, [3]);

  // A second player's mark lands on the SAME shared list.
  applyNote(state, "b", "add", i, 7);
  const both = applyNote(state, "b", "add", i, 5);
  if (both.verdict === "applied") assert.deepEqual(both.values, [3, 5, 7], "sorted canonical order");

  // Removal takes exactly one mark away for everyone.
  const removed = applyNote(state, "a", "remove", i, 3);
  if (removed.verdict === "applied") assert.deepEqual(removed.values, [5, 7]);

  // Idempotent clicks echo the canonical list without duplicating.
  const repeat = applyNote(state, "a", "remove", i, 3);
  if (repeat.verdict === "applied") assert.deepEqual(repeat.values, [5, 7]);

  // Last mark removed deletes the entry entirely.
  applyNote(state, "a", "remove", i, 5);
  const last = applyNote(state, "b", "remove", i, 7);
  if (last.verdict === "applied") assert.deepEqual(last.values, []);

  // Notes obey the same eligibility rules as placements.
  const givenIndex = givens.findIndex((v) => v !== 0);
  assert.equal(applyNote(state, "a", "add", givenIndex, 1).verdict, "rejected");
});

test("notes merge deterministically when two players race one cell", () => {
  // Arrival-order independence: applying the same two adds in either order
  // yields the identical shared list.
  const runOrder = ["a", "b"];
  const reverseOrder = ["b", "a"];
  const finalValues = (order: string[]): number[] => {
    const { state, givens } = playing(["a", "b"]);
    const i = firstEditableCell(givens);
    for (const id of order) applyNote(state, id, "add", i, id === "a" ? 4 : 6);
    return state.notes.get(i) ?? [];
  };
  assert.deepEqual(finalValues(runOrder), [4, 6]);
  assert.deepEqual(finalValues(reverseOrder), [4, 6]);
});

test("simultaneous placement attempts on one cell resolve by arrival order", () => {
  const { state, solution, givens } = playing(["a", "b"]);
  const i = firstEditableCell(givens);
  const correct = solution[i]!;
  const wrong = (correct % 9) + 1;

  // Order 1: wrong digit arrives first — cell stays open, right one claims it.
  const first = judgePlacement(state, "a", i, wrong, NOW);
  assert.equal(first.verdict, "incorrect");
  const second = judgePlacement(state, "b", i, correct, NOW + 1);
  assert.equal(second.verdict, "accepted");
  assert.equal(state.owners.get(i), "b");

  // Order 2: correct digit first — everything afterwards sees the cell taken.
  const replay = playing(["a", "b"], 99);
  const claim = judgePlacement(replay.state, "b", i, correct, NOW);
  assert.equal(claim.verdict, "accepted");
  assert.deepEqual(judgePlacement(replay.state, "a", i, wrong, NOW + 1), {
    verdict: "rejected",
    reason: "cell-taken",
    i,
  });
});

test("snapshots carry full playable state but never the solution", () => {
  const { state, solution, givens } = playing(["a", "b"]);
  const i = firstEditableCell(givens);
  judgePlacement(state, "a", i, solution[i]!, NOW + 1);
  // A second guaranteed-editable cell for the shared pencil mark.
  const j = givens.findIndex((value, index) => value === 0 && index !== i);
  const noted = applyNote(state, "b", "add", j, 8);
  assert.ok(noted.verdict === "applied");

  const snapshot = buildSnapshot(state, ["a"], NOW + 2);
  const encoded = JSON.stringify(snapshot);
  assert.ok(!encoded.includes(gridOf(solution)), "the solution must never leak onto the wire");

  assert.equal(snapshot.status, "in-progress");
  assert.equal(snapshot.board[i], String(solution[i]));
  assert.equal(snapshot.owners[String(i)], "a");
  assert.equal(snapshot.onlineIds.join(","), "a", "offline seats stay in the roster, out of onlineIds");
  assert.ok(!snapshot.onlineIds.includes("b"));
  assert.equal(snapshot.players.length, 2, "reconnecting players see the full roster");
  assert.deepEqual(snapshot.notes[String(j)], [8]);
  assert.equal(typeof snapshot.serverNow, "number");
  assert.equal(snapshot.givens.length, 81);
  assert.equal(snapshot.board.length, 81);
});

function gridOf(grid: readonly number[]): string {
  return JSON.stringify(Array.from(grid));
}

test("leaving players leave their solved cells behind", () => {
  const { state, solution, givens } = playing(["a", "b"]);
  const i = firstEditableCell(givens);
  judgePlacement(state, "a", i, solution[i]!, NOW + 1);
  applyLeave(state, "a");
  assert.equal(state.cells[i], solution[i], "cooperative work survives departures");
  assert.equal(state.placements["a"], 1, "contribution stats persist for the victory screen");
});
