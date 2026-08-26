import type { LobbySnapshot, ServerMessage } from "../../../shared/protocol";
import type { CloseInfo, Connection } from "../net/connection";

const TICK_MS = 500;
const NOTICE_MS = 4000;
const MAX_NAME_LENGTH = 32;

export type PlayerRow = {
  id: string;
  name: string;
  avatar: string | null;
  isHost: boolean;
  isYou: boolean;
  online: boolean;
  mistakes: number;
  placements: number;
};

export type GameState = {
  phase: "boot" | "lobby" | "playing" | "victory";
  connectionKind: Connection["kind"] | null;
  you: string | null;
  name: string;
  players: PlayerRow[];
  isHost: boolean;
  /** Immutable starting clues, 81 chars. */
  givens: string;
  /** Authoritative board — givens plus accepted placements, `.` for empty. */
  board: string;
  owners: Record<string, string>;
  notes: Record<string, number[]>;
  difficulty: LobbySnapshot["difficulty"];
  startedAt: number | null;
  completedAt: number | null;
  elapsedSeconds: number;
  /** Relay-clock minus local clock at the last snapshot, for timer math. */
  clockOffsetMs: number | null;
  notice: { text: string; kind: "info" | "error" } | null;
};

export type GameEvents = {
  onState: (state: GameState) => void;
  /** Your submission was judged wrong; the UI flashes cell i and restores it. */
  onInvalid: (i: number) => void;
  /** Any accepted placement anywhere — chime cue. */
  onCellUpdated: (i: number, v: number, byPlayer: string) => void;
  onNoteChanged: (i: number, values: number[], byPlayer: string) => void;
  onPeerCursor: (byPlayer: string, i: number) => void;
  onLinkLost: (info: CloseInfo) => void;
};

/**
 * Client-side lobby brain. Renders ServerMessages into UI state; it never
 * decides correctness — every accepted digit arrives already judged by the
 * relay, and this class only reconciles what it shows. Optimistic placements
 * are provisional paint that the next server echo confirms or reverts.
 */
export class GameClient {
  private connection: Connection | null = null;
  private snapshot: LobbySnapshot | null = null;
  private you: string | null = null;
  private connected_ = false;
  /**
   * Placements sent but not yet echoed. They paint immediately so typing
   * feels instant; any authoritative board (event or snapshot) supersedes
   * them, and an `invalid` ruling reverts exactly the rejected cell.
   */
  private pending = new Map<number, number>();
  private clockOffset: number | null = null;
  private notice: GameState["notice"] = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  // Explicit fields rather than constructor-parameter properties: strip-only
  // TS runtimes (node --test) reject the shorthand, and testability wins.
  private readonly events: GameEvents;
  private name: string;
  private readonly avatar: string | null;

  constructor(events: GameEvents, name: string, avatar: string | null = null) {
    this.events = events;
    this.name = name;
    this.avatar = avatar;
    this.tickTimer = setInterval(() => this.onTick(), TICK_MS);
  }

  get kind(): Connection["kind"] | null {
    return this.connection?.kind ?? null;
  }

  /** False between a transport failure and the next successful connect(). */
  get connected(): boolean {
    return this.connected_;
  }

  get playerName(): string {
    return this.name;
  }

  get playerAvatar(): string | null {
    return this.avatar;
  }

  connect(connection: Connection): void {
    this.connection = connection;
    this.connected_ = true;
    this.snapshot = null;
    this.pending.clear();
    connection.send({ t: "hello", name: this.name, avatar: this.avatar });
    this.emit();
  }

  onMessage = (message: ServerMessage): void => {
    if (this.disposed) {
      return;
    }
    switch (message.t) {
      case "welcome":
        this.you = message.you;
        this.applySnapshot(message.snapshot);
        break;
      case "snapshot":
        this.applySnapshot(message.snapshot);
        break;
      case "host": {
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, hostId: message.hostId };
        }
        break;
      }
      case "cell-updated":
        // Authoritative paint: drop any matching optimistic entry first.
        this.pending.delete(message.i);
        if (this.snapshot) {
          const chars = [...this.snapshot.board];
          chars[message.i] = String(message.v);
          this.snapshot = {
            ...this.snapshot,
            board: chars.join(""),
            owners: { ...this.snapshot.owners, [String(message.i)]: message.byPlayer },
          };
        }
        this.events.onCellUpdated(message.i, message.v, message.byPlayer);
        break;
      case "note-changed":
        if (this.snapshot) {
          const notes = { ...this.snapshot.notes };
          if (message.values.length === 0) {
            delete notes[String(message.i)];
          } else {
            notes[String(message.i)] = [...message.values];
          }
          this.snapshot = { ...this.snapshot, notes };
        }
        this.events.onNoteChanged(message.i, message.values, message.byPlayer);
        break;
      case "invalid":
        this.pending.delete(message.i);
        this.events.onInvalid(message.i);
        break;
      case "cursor":
        // Pure relay traffic: the board paints peer selections directly, so a
        // full GameState rebuild per selection change would churn the UI thread.
        this.events.onPeerCursor(message.byPlayer, message.i);
        return;
      case "rejected":
        this.setNotice(`Rejected: ${message.reason}`, "error");
        break;
      case "pong":
        return; // keepalive answered; nothing observable changed
    }
    this.emit();
  };

  /** Transport failure. State stays mounted so a quick reconnect resumes invisibly. */
  onClose = (info: CloseInfo): void => {
    if (this.disposed || this.connection === null) {
      return;
    }
    this.connection = null;
    this.connected_ = false;
    this.events.onLinkLost(info);
    this.emit();
  };

  /** Mid-reconnect limbo: keep the last known board rendered under a notice. */
  pauseForReconnect(attempt: number, max: number): void {
    this.setNotice(`Connection lost — reconnecting (${attempt}/${max})…`, "error");
    this.emit();
  }

  /** Retries exhausted: give up the seat honestly before the solo lobby opens. */
  degradeToSolo(detail: string): void {
    this.connected_ = false;
    this.you = null;
    this.setNotice(`Couldn't reach the lobby (${detail}) — practicing solo`, "info");
    this.emit();
  }

  rename(rawName: string): void {
    const name = rawName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name || name === this.name) {
      return;
    }
    this.name = name;
    // The avatar rides along because the relay treats hello as the full
    // identity: omitting it would read as "no avatar" and wipe the seat's.
    this.connection?.send({ t: "hello", name, avatar: this.avatar });
    this.emit();
  }

  startGame(difficulty?: GameState["difficulty"]): void {
    if (!this.isHost()) {
      return;
    }
    this.pending.clear();
    this.send(difficulty ? { t: "start", difficulty } : { t: "start" });
  }

  place(i: number, v: number): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.status !== "in-progress") {
      return;
    }
    if (snapshot.givens[i] !== "." || snapshot.board[i] !== ".") {
      return;
    }
    // Optimistic paint; the relay's echo is the correction of record.
    this.pending.set(i, v);
    this.send({ t: "place", i, v });
    this.emit();
  }

  addNote(i: number, v: number): void {
    if (this.canEdit(i)) {
      this.send({ t: "add-note", i, v });
    }
  }

  removeNote(i: number, v: number): void {
    if (this.canEdit(i)) {
      this.send({ t: "remove-note", i, v });
    }
  }

  sendCursor(i: number): void {
    // Peer selections are the bulk of relay traffic and every relayed frame
    // is a billable request on the worker; a solo session has nobody to show
    // them to and should transmit nothing at all.
    if ((this.snapshot?.players.length ?? 1) < 2) {
      return;
    }
    this.send({ t: "cursor", i });
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.tickTimer);
    this.clearNotice();
    this.connection?.close();
    this.connection = null;
  }

  private canEdit(i: number): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.status !== "in-progress") {
      return false;
    }
    return snapshot.givens[i] === "." && snapshot.board[i] === ".";
  }

  private applySnapshot(snapshot: LobbySnapshot): void {
    // The relay's board is the truth; optimistic entries survive only where
    // the snapshot still shows those cells empty (their echo is in flight).
    for (const [cell, value] of [...this.pending]) {
      if (snapshot.board[cell] !== ".") {
        this.pending.delete(cell);
      } else if (value === undefined) {
        this.pending.delete(cell);
      }
    }
    if (typeof snapshot.serverNow === "number") {
      this.clockOffset = snapshot.serverNow - Date.now();
    }
    this.snapshot = snapshot;
  }

  private isHost(): boolean {
    return this.you !== null && this.snapshot?.hostId === this.you;
  }

  private elapsedSeconds(): number {
    const startedAt = this.snapshot?.startedAt;
    if (startedAt === null || startedAt === undefined) {
      return 0;
    }
    const end = this.snapshot?.completedAt ?? Date.now() + (this.clockOffset ?? 0);
    return Math.max(0, Math.round((end - startedAt) / 1000));
  }

  private onTick(): void {
    if (this.snapshot?.status === "in-progress") {
      this.emit();
    }
  }

  private setNotice(text: string, kind: "info" | "error"): void {
    this.notice = { text, kind };
    this.clearNotice();
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.emit();
    }, NOTICE_MS);
  }

  private clearNotice(): void {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  }

  private send(message: Parameters<Connection["send"]>[0]): void {
    this.connection?.send(message);
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.snapshot;
    let board = snapshot?.board ?? "";
    if (board && this.pending.size > 0) {
      const chars = [...board];
      for (const [cell, value] of this.pending) {
        if (chars[cell] === ".") {
          chars[cell] = String(value);
        }
      }
      board = chars.join("");
    }
    const status = snapshot?.status;
    const phase: GameState["phase"] =
      status === "in-progress" ? "playing" : status === "completed" ? "victory" : "lobby";
    this.events.onState({
      phase,
      connectionKind: this.connection?.kind ?? null,
      you: this.you,
      name: this.name,
      players: (snapshot?.players ?? []).map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar ?? null,
        isHost: player.id === snapshot?.hostId,
        isYou: player.id === this.you,
        online: snapshot?.onlineIds.includes(player.id) ?? false,
        mistakes: snapshot?.mistakes[player.id] ?? 0,
        placements: snapshot?.placements[player.id] ?? 0,
      })),
      isHost: this.isHost(),
      givens: snapshot?.givens ?? "",
      board,
      owners: snapshot?.owners ?? {},
      notes: snapshot?.notes ?? {},
      difficulty: snapshot?.difficulty ?? "medium",
      startedAt: snapshot?.startedAt ?? null,
      completedAt: snapshot?.completedAt ?? null,
      elapsedSeconds: this.elapsedSeconds(),
      clockOffsetMs: this.clockOffset,
      notice: this.notice,
    });
  }
}
