export type Player = {
  id: string;
  name: string;
  /** Discord avatar hash when the seat is authenticated; absent for guests. */
  avatar?: string | null;
};

export type Phase = "lobby" | "playing" | "victory";

/** Per-seat session totals; the relay owns them so rejoins recover fully. */
export type RoundTally = {
  /** Puzzles finished first — one point each. */
  wins: number;
  /** Puzzles finished at all, including after the winner claimed. */
  solves: number;
};

export type RoomSnapshot = {
  hostId: string | null;
  players: Player[];
  phase: Phase;
  packId: string | null;
  /**
   * Full shuffled puzzle order fixed at start; identical on every client.
   * Present only in the welcome and starting snapshots — every seat already
   * holds it, so routine snapshots omit it to keep fan-out light.
   */
  order?: string[];
  /** Index into `order` of the shared puzzle; null while not playing. */
  orderIndex: number | null;
  /** Host's choice at start: does this session grant stuck-player hints. */
  hintsEnabled: boolean;
  /** Correctly placed cell count per seat, for the live progress bars. */
  progress: Record<string, number>;
  /** Finish time (relay seconds) per seat for the CURRENT puzzle only. */
  finishes: Record<string, number>;
  tallies: Record<string, RoundTally>;
  /** Seats that voted to return to the lobby; unanimous consent ends the session. */
  lobbyVotes?: string[];
  /** Lobby pack nominations, by player id — feeds the democratic random pick. */
  packVotes?: Record<string, string>;
  /** Relay-clock ms when the open nominations roll into a random choice. */
  packVoteDeadline?: number;
  /** The rolled winner; clients play the reveal, then the host starts it. */
  chosenPackId?: string;
  /**
   * Relay-clock ms when the interlude between puzzles ends and the relay
   * advances (or closes the session on the last puzzle). Present only while
   * a winner has claimed and the countdown runs.
   */
  roundEndsAt?: number;
  /** Derived convenience: order[orderIndex], null when out of game. */
  puzzleId: string | null;
  startedAt: number | null;
  /**
   * Relay clock at snapshot time. startedAt lives on the relay's clock, so
   * clients anchor an offset against this instead of assuming NTP-perfect
   * devices; absent locally where both clocks are one clock.
   */
  serverNow?: number;
};

/**
 * Exact wire frames of the browser keepalive. GameRoom registers its
 * hibernation auto-responder against these literal bytes — build both sides
 * from these constants so the pair can never drift apart.
 */
export const PING_MESSAGE: ClientMessage = { t: "ping" };
export const PONG_MESSAGE: ServerMessage = { t: "pong" };

export type ClientMessage =
  | { t: "hello"; name: string; avatar?: string | null }
  | { t: "ping" }
  /** Host-only: launch a session over `order` (shuffled puzzle ids). */
  | { t: "start"; packId: string; order: string[]; hints?: boolean }
  /** A digit locked into cell i (0..80); relayed live, never stored. */
  | { t: "place"; i: number; v: number }
  /** Correctly placed cell count; persisted for the progress bars. */
  | { t: "progress"; placed: number }
  /** This seat completed the current puzzle; first claim wins it. */
  | { t: "solved"; seconds: number }
  /** During an interlude: vote to skip the wait and advance now. */
  | { t: "next" }
  /** Host-only: leave victory (or abort a session) and reopen the picker. */
  | { t: "lobby" }
  /** Any player: toggle a vote to send everyone back to the picker. */
  | { t: "vote-lobby" }
  /** Lobby: nominate a pack for the democratic random roll. */
  | { t: "pack-vote"; packId: string }
  /** Lobby: nudge the relay to roll nominations whose deadline has passed. */
  | { t: "pack-vote-resolve" };

export type ServerMessage =
  | { t: "welcome"; you: string; snapshot: RoomSnapshot }
  | { t: "snapshot"; snapshot: RoomSnapshot }
  | { t: "host"; hostId: string }
  /** Live peer placement so rival boards visibly fill in. */
  | { t: "place"; byPlayer: string; i: number; v: number }
  | { t: "round-won"; byPlayer: string; seconds: number }
  /** Session closed on the last puzzle; carries its winner for the fanfare. */
  | { t: "session-end"; byPlayer: string; seconds: number }
  | { t: "rejected"; reason: string }
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
