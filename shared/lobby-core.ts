import type { Difficulty, LobbySnapshot, Player } from "./protocol.ts";
import { DEFAULT_MAX_PLAYERS, isValidCellIndex, isValidDigit } from "./protocol.ts";
import { generatePuzzle, gridToString, isDifficulty } from "./sudoku.ts";

/**
 * Pure authoritative rules of the shared board — no Durable Object state,
 * no I/O, no clock reads (callers stamp time). The Lobby DO only hydrates,
 * delegates, persists, and fans out; every decision that makes the lobby
 * THE single source of truth lives here so it is unit-testable without a
 * runtime and deterministic under concurrent proposals (the DO applies them
 * serially in arrival order; these functions define what each arrival does).
 */

export const MAX_NAME_LENGTH = 32;
// Full CDN URLs (guild avatars included) run ~80-100 chars.
const MAX_AVATAR_LENGTH = 512;

export type LobbyStatus = "waiting" | "in-progress" | "completed";

/**
 * The ONE shared game state per lobby. `solution` is server-only: it must be
 * stripped before anything crosses the wire (see buildSnapshot) — a client
 * holding the solution could auto-solve, which defeats the whole game.
 */
export type LobbyState = {
  players: PlayerRecord[];
  hostId: string | null;
  /** Most recent handoff donor, so a refresh can reclaim an idle crown. */
  lastHostId: string | null;
  status: LobbyStatus;
  difficulty: Difficulty;
  /** Immutable starting clues (0 = blank). */
  givens: number[];
  /** Authoritative board: givens plus accepted placements. */
  cells: number[];
  /** Server-only unique solution; placements are validated against it. */
  solution: number[];
  /** Placed cell index → playerId of whoever filled it. */
  owners: Map<number, string>;
  /** Shared pencil marks: cell index → sorted digits. */
  notes: Map<number, number[]>;
  mistakes: Record<string, number>;
  placements: Record<string, number>;
  startedAt: number | null;
  completedAt: number | null;
  /** Last broker heartbeat wall-clock; a throttle stamp, not game state. */
  brokerBeatAt?: number;
};

export type PlayerRecord = {
  id: string;
  name: string;
  avatar?: string | null;
  joinedAt: number;
  /**
   * Last sweep that saw a live socket for this seat. Absent on records
   * persisted before ghost reconciliation — stamped, never evicted, on
   * first sight so seats age in instead of vanishing outright.
   */
  lastSeenAt?: number;
};

/** Outcomes the DO turns into wire messages and persistence decisions. */
export type Effect =
  | { kind: "cell-updated"; i: number; v: number; byPlayer: string }
  | { kind: "note-changed"; i: number; values: number[]; byPlayer: string }
  /** Private to the submitter. */
  | { kind: "invalid"; i: number }
  | { kind: "host-changed"; hostId: string }
  | { kind: "started" }
  | { kind: "completed" }
  /** Pure relay traffic; never persisted. */
  | { kind: "cursor"; byPlayer: string; i: number };

export type ApplyOk = { ok: true; effect: Effect | null };
export type ApplyErr = { ok: false; reason: string };
export type ApplyResult = ApplyOk | ApplyErr;

export function createLobby(difficulty: Difficulty): LobbyState {
  return {
    players: [],
    hostId: null,
    lastHostId: null,
    status: "waiting",
    difficulty,
    givens: new Array(81).fill(0),
    cells: new Array(81).fill(0),
    solution: new Array(81).fill(0),
    owners: new Map(),
    notes: new Map(),
    mistakes: {},
    placements: {},
    startedAt: null,
    completedAt: null,
  };
}

function sanitizeName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

/**
 * Avatars render as <img src>, so the only sanitization that matters is
 * "is it an https URL we are willing to display"; rewriting the string would
 * just corrupt it.
 */
function sanitizeAvatar(rawAvatar: unknown): string | null {
  return typeof rawAvatar === "string" &&
    rawAvatar.startsWith("https://") &&
    rawAvatar.length <= MAX_AVATAR_LENGTH
    ? rawAvatar
    : null;
}

export function findPlayer(state: LobbyState, playerId: string): PlayerRecord | undefined {
  return state.players.find((p) => p.id === playerId);
}

export function isMember(state: LobbyState, playerId: string): boolean {
  return findPlayer(state, playerId) !== undefined;
}

/** Hard ceiling so a misconfigured MAX_PLAYERS var cannot admit unbounded rooms. */
export function resolveMaxPlayers(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_MAX_PLAYERS;
  }
  return Math.min(30, Math.max(1, parsed));
}

/**
 * Hello handling. A brand-new id takes a seat (while the roster cap holds);
 * a known id is a returning player (refresh or reconnect) refreshing their
 * identity — never a duplicate row. First joiner becomes host; a page
 * refresh that closed the old socket before the new hello arrived can hand
 * the crown away, so the refresher reclaims it and Start never wanders off
 * the room's owner.
 */
export function applyHello(
  state: LobbyState,
  playerId: string,
  rawName: unknown,
  rawAvatar: unknown,
  now: number,
  maxPlayers: number,
): ApplyOk | ApplyErr {
  const name = sanitizeName(rawName);
  const avatar = sanitizeAvatar(rawAvatar);
  let player = findPlayer(state, playerId);
  if (!player && state.players.length >= Math.max(1, maxPlayers)) {
    return { ok: false, reason: "lobby-full" };
  }
  if (!player) {
    player = { id: playerId, name, avatar, joinedAt: now, lastSeenAt: now };
    state.players.push(player);
  } else {
    player.name = name;
    player.avatar = avatar;
    player.lastSeenAt = now;
  }

  let newHost: string | null = null;
  if (state.hostId === null) {
    state.hostId = playerId;
    newHost = playerId;
  } else if (
    state.hostId !== playerId &&
    state.lastHostId === playerId &&
    state.players[0]?.id === playerId
  ) {
    state.hostId = playerId;
    newHost = playerId;
  }
  return { ok: true, effect: newHost ? { kind: "host-changed", hostId: newHost } : null };
}

/**
 * Drops one seat and settles everything that depended on it — host handoff.
 * Shared by the socket-close path and the alarm's ghost sweep so both leave
 * the roster in exactly the same shape. Returns the new host when the crown
 * moved (null otherwise).
 */
export function applyLeave(state: LobbyState, playerId: string): string | null {
  const departed = findPlayer(state, playerId);
  state.players = state.players.filter((p) => p.id !== playerId);
  if (!departed || state.players.length === 0) {
    if (state.players.length === 0) {
      state.hostId = null;
    }
    return null;
  }
  // Their contributions stay on the board with their name attached — leaving
  // must not un-solve cells other players are building on.
  if (state.hostId === playerId) {
    state.lastHostId = playerId;
    state.hostId = state.players[0].id;
    return state.hostId;
  }
  return null;
}

/**
 * Host-only launch. From `waiting` it deals a fresh puzzle; from `completed`
 * it deals another one (play again). Mid-game starts are refused — aborting
 * a live board is a deliberate product non-feature for a cooperative game.
 */
export function applyStart(
  state: LobbyState,
  hostId: string,
  difficulty: unknown,
  seed: number,
  now: number,
): ApplyResult {
  if (state.hostId !== hostId) {
    return { ok: false, reason: "not-host" };
  }
  const chosen = difficulty === undefined ? state.difficulty : difficulty;
  if (!isDifficulty(chosen)) {
    return { ok: false, reason: "invalid-difficulty" };
  }
  if (state.status === "in-progress") {
    return { ok: false, reason: "game-in-progress" };
  }
  const puzzle = generatePuzzle(chosen, seed);
  state.status = "in-progress";
  state.difficulty = chosen;
  state.givens = puzzle.givens.slice();
  state.cells = puzzle.givens.slice();
  state.solution = puzzle.solution;
  state.owners = new Map();
  state.notes = new Map();
  state.mistakes = {};
  state.placements = {};
  state.startedAt = now;
  state.completedAt = null;
  return { ok: true, effect: { kind: "started" } };
}

export type Placement =
  | { verdict: "accepted"; i: number; v: number; byPlayer: string; solved: boolean }
  | { verdict: "rejected"; reason: string; i?: number }
  | { verdict: "incorrect"; i: number };

/**
 * The heart of server authority: judge a proposed digit against the
 * server-only solution. Wrong digits NEVER touch the shared board — the
 * submitter alone learns their guess was wrong, everyone else sees nothing.
 *
 * Simultaneous proposals resolve by arrival order inside the DO's single
 * thread: the first correct digit claims the empty cell, later proposals for
 * that cell see it taken. Nothing is decided client-side, so clients cannot
 * hold conflicting versions of the board.
 */
export function judgePlacement(
  state: LobbyState,
  playerId: string,
  i: unknown,
  v: unknown,
  now: number,
): Placement {
  if (state.status === "waiting") {
    return { verdict: "rejected", reason: "game-not-started" };
  }
  if (state.status === "completed") {
    return { verdict: "rejected", reason: "game-completed", i: isValidCellIndex(i) ? i : undefined };
  }
  if (!isValidCellIndex(i)) {
    return { verdict: "rejected", reason: "invalid-cell" };
  }
  if (!isValidDigit(v)) {
    return { verdict: "rejected", reason: "invalid-value", i };
  }
  if (state.givens[i] !== 0) {
    return { verdict: "rejected", reason: "given-cell", i };
  }
  if (state.cells[i] !== 0) {
    return { verdict: "rejected", reason: "cell-taken", i };
  }
  if (state.solution[i] !== v) {
    state.mistakes[playerId] = (state.mistakes[playerId] ?? 0) + 1;
    return { verdict: "incorrect", i };
  }

  state.cells[i] = v;
  state.owners.set(i, playerId);
  state.placements[playerId] = (state.placements[playerId] ?? 0) + 1;
  // Pencil marks for a solved cell are noise; the placement supersedes them.
  state.notes.delete(i);
  const solved = state.cells.every((cell) => cell !== 0);
  if (solved) {
    state.status = "completed";
    state.completedAt = now;
  }
  return { verdict: "accepted", i, v, byPlayer: playerId, solved };
}

export type NoteChange =
  | { verdict: "applied"; i: number; values: number[]; byPlayer: string }
  | { verdict: "rejected"; reason: string; i?: number };

/**
 * Shared note state. Both verbs funnel through here so add and remove obey
 * identical eligibility rules (empty editable cell, game live) and produce
 * the same canonical sorted-digit event — clients re-render the whole list
 * instead of reconciling deltas, which keeps every board identical even when
 * two players toggle notes on the same cell back-to-back.
 */
export function applyNote(
  state: LobbyState,
  playerId: string,
  mode: "add" | "remove",
  i: unknown,
  v: unknown,
): NoteChange {
  if (state.status !== "in-progress") {
    return { verdict: "rejected", reason: state.status === "waiting" ? "game-not-started" : "game-completed" };
  }
  if (!isValidCellIndex(i)) {
    return { verdict: "rejected", reason: "invalid-cell" };
  }
  if (!isValidDigit(v)) {
    return { verdict: "rejected", reason: "invalid-value", i };
  }
  if (state.givens[i] !== 0) {
    return { verdict: "rejected", reason: "given-cell", i };
  }
  if (state.cells[i] !== 0) {
    return { verdict: "rejected", reason: "cell-taken", i };
  }

  const current = new Set(state.notes.get(i) ?? []);
  if (mode === "add" ? !current.has(v) : current.has(v)) {
    if (mode === "add") {
      current.add(v);
    } else {
      current.delete(v);
    }
    if (current.size === 0) {
      state.notes.delete(i);
    } else {
      state.notes.set(i, [...current].sort((a, b) => a - b));
    }
  }
  // Idempotent clicks still echo the canonical list so the actor gets feedback.
  return {
    verdict: "applied",
    i,
    values: state.notes.get(i) ?? [],
    byPlayer: playerId,
  };
}

/**
 * Wire-safe projection. Strips the solution unconditionally — this is the
 * ONLY sanctioned path from LobbyState to the network, and nothing here may
 * read state.solution. `onlineIds` comes from the DO's live socket table;
 * core state deliberately does not track presence, so snapshots answer
 * "who is online right now" truthfully after any reconnect.
 */
export function buildSnapshot(
  state: LobbyState,
  onlineIds: readonly string[],
  now: number,
): LobbySnapshot {
  const players: Player[] = state.players.map(({ id, name, avatar }) => ({
    id,
    name,
    ...(avatar ? { avatar } : {}),
  }));
  const owners: Record<string, string> = {};
  for (const [i, ownerId] of state.owners) {
    owners[String(i)] = ownerId;
  }
  const notes: Record<string, number[]> = {};
  for (const [i, values] of state.notes) {
    notes[String(i)] = [...values];
  }
  return {
    hostId: state.hostId,
    players,
    onlineIds: state.players.filter((p) => onlineIds.includes(p.id)).map((p) => p.id),
    status: state.status,
    difficulty: state.difficulty,
    givens: gridToString(state.givens),
    board: gridToString(state.cells),
    owners,
    notes,
    mistakes: { ...state.mistakes },
    placements: { ...state.placements },
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    serverNow: now,
  };
}
