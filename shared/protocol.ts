/**
 * Wire contract between the browser client and the lobby relay.
 *
 * The server is the single source of truth: clients propose actions
 * (`place`, `add-note`, `remove-note`), the relay validates them against the
 * server-only solution and either applies them to the ONE shared board and
 * broadcasts, or rejects privately. The Sudoku solution never crosses this
 * contract — a client that knows the answers could auto-solve, so snapshots
 * carry only what players may see (see LobbySnapshot).
 */

export type Player = {
  id: string;
  name: string;
  /** Discord avatar hash when the seat is authenticated; absent for guests. */
  avatar?: string | null;
};

export type LobbyStatus = "waiting" | "in-progress" | "completed";

export type Difficulty = "easy" | "medium" | "hard";

/** Overridable via the worker's MAX_PLAYERS var; lobbies cap at this. */
export const DEFAULT_MAX_PLAYERS = 8;

/** Cell indexes 0..80, row-major. */
export const CELL_COUNT = 81;

export function isValidCellIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < CELL_COUNT;
}

export function isValidDigit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
}

export type LobbySnapshot = {
  hostId: string | null;
  players: Player[];
  /** Seats with a live socket right now; roster entries without these are offline. */
  onlineIds: string[];
  status: LobbyStatus;
  difficulty: Difficulty;
  /** 81 chars, digits 1-9 + `.` blanks — the immutable starting clues. */
  givens: string;
  /** 81 chars — givens plus every accepted placement, `.` for empty cells. */
  board: string;
  /** Placed cell index → playerId of whoever filled it (givens have no owner). */
  owners: Record<string, string>;
  /** Shared pencil marks: cell index → sorted digits. */
  notes: Record<string, number[]>;
  /** Wrong submissions per player this game. */
  mistakes: Record<string, number>;
  /** Correct placements per player this game — the victory screen's contribution stat. */
  placements: Record<string, number>;
  startedAt: number | null;
  completedAt: number | null;
  /**
   * Relay clock at snapshot time. startedAt lives on the relay's clock, so
   * clients anchor an offset against this instead of assuming NTP-perfect
   * devices; absent locally where both clocks are one clock.
   */
  serverNow?: number;
};

/**
 * Exact wire frames of the browser keepalive. The lobby registers its
 * hibernation auto-responder against these literal bytes — build both sides
 * from these constants so the pair can never drift apart.
 */
export const PING_MESSAGE: ClientMessage = { t: "ping" };
export const PONG_MESSAGE: ServerMessage = { t: "pong" };

export type ClientMessage =
  | { t: "hello"; name: string; avatar?: string | null }
  | { t: "ping" }
  /**
   * Host-only. From `waiting`: launch the game. From `completed`: deal a
   * fresh puzzle (same message, new board) — one verb covers both so the
   * relay stays minimal.
   */
  | { t: "start"; difficulty?: Difficulty }
  /** Submit a digit for an empty editable cell; the relay judges correctness. */
  | { t: "place"; i: number; v: number }
  | { t: "add-note"; i: number; v: number }
  | { t: "remove-note"; i: number; v: number }
  /** Which cell this seat has selected; relayed live, never stored. */
  | { t: "cursor"; i: number };

export type ServerMessage =
  | { t: "welcome"; you: string; snapshot: LobbySnapshot }
  | { t: "snapshot"; snapshot: LobbySnapshot }
  | { t: "host"; hostId: string }
  /** A placement was accepted; every client paints cell i immediately. */
  | { t: "cell-updated"; i: number; v: number; byPlayer: string }
  /** Shared note state changed; `values` is the full sorted list for the cell. */
  | { t: "note-changed"; i: number; values: number[]; byPlayer: string }
  /** Private to the submitter: that digit does not belong in cell i. */
  | { t: "invalid"; i: number }
  | { t: "cursor"; byPlayer: string; i: number }
  | { t: "rejected"; reason: string; i?: number }
  | { t: "pong" };

/**
 * Close codes used when the server ends a socket. 4002 is referenced by
 * `rejected` above: capacity-rejected rooms accept the socket, deliver the
 * message, then close with this code so both structured and transport-level
 * signals agree.
 */
export const CLOSE_CAPACITY = 4002;
export const CLOSE_ROOM_FULL = 4003;
export const CLOSE_HELLO_TIMEOUT = 4001;
export const CLOSE_UNVERIFIED = 4004;
