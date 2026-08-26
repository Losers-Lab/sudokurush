import type { ClientMessage, ServerMessage } from "../../../shared/protocol";
import {
  applyHello,
  applyLeave,
  applyNote,
  applyStart,
  buildSnapshot,
  createLobby,
  judgePlacement,
  type Effect,
  type LobbyState,
} from "../../../shared/lobby-core";
import { dispatchMessage, type Connection, type ConnectionHandlers } from "./connection";

/**
 * In-browser loopback for solo practice. It runs the relay's EXACT rules —
 * shared/lobby-core is imported verbatim, not mirrored — so solo semantics
 * can never drift from multiplayer: same validation chain, same mistake
 * accounting, same completion detection. Solo holds the solution because it
 * IS the server here; nothing is shared, so nothing can be cheated.
 */
export class LocalConnection implements Connection {
  readonly kind = "local" as const;

  private readonly handlers: ConnectionHandlers;
  private readonly playerId: string;
  private state: LobbyState | null = createLobby("medium");
  private outbox: ServerMessage[] = [];
  private closed = false;

  constructor(handlers: ConnectionHandlers, name: string) {
    this.handlers = handlers;
    this.playerId = crypto.randomUUID();
    // The lone local seat is always the host; say hello like any client would.
    this.applyHello(name.trim().slice(0, 32) || "Player", null);
  }

  send(message: ClientMessage): void {
    if (this.closed || this.state === null) {
      return;
    }
    switch (message.t) {
      case "hello":
        this.applyHello(message.name, message.avatar ?? null);
        break;
      case "ping":
        this.enqueue({ t: "pong" });
        break;
      case "start": {
        const result = applyStart(this.state, this.playerId, message.difficulty, randomSeed(), Date.now());
        if (!result.ok) {
          this.enqueue({ t: "rejected", reason: result.reason });
          return;
        }
        this.flushEffect(result.effect);
        break;
      }
      case "place": {
        const judged = judgePlacement(this.state, this.playerId, message.i, message.v, Date.now());
        if (judged.verdict === "rejected") {
          this.enqueue({
            t: "rejected",
            reason: judged.reason,
            ...(judged.i !== undefined ? { i: judged.i } : {}),
          });
          return;
        }
        if (judged.verdict === "incorrect") {
          this.enqueue({ t: "invalid", i: judged.i });
          this.emitSnapshot();
          return;
        }
        this.enqueue({ t: "cell-updated", i: judged.i, v: judged.v, byPlayer: judged.byPlayer });
        this.emitSnapshot();
        break;
      }
      case "add-note":
      case "remove-note": {
        const judged = applyNote(
          this.state,
          this.playerId,
          message.t === "add-note" ? "add" : "remove",
          message.i,
          message.v,
        );
        if (judged.verdict === "rejected") {
          this.enqueue({
            t: "rejected",
            reason: judged.reason,
            ...(judged.i !== undefined ? { i: judged.i } : {}),
          });
          return;
        }
        this.flushEffect({ kind: "note-changed", i: judged.i, values: judged.values, byPlayer: judged.byPlayer });
        break;
      }
      // Solo has nobody to show a selection to.
      case "cursor":
        break;
    }
  }

  close(): void {
    this.closed = true;
    this.outbox = [];
    if (this.state) {
      applyLeave(this.state, this.playerId);
      this.state = null;
    }
  }

  private applyHello(name: string, avatar: string | null): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const result = applyHello(state, this.playerId, name, avatar, Date.now());
    this.enqueue({ t: "welcome", you: this.playerId, snapshot: this.snapshot() });
    if (result.effect?.kind === "host-changed") {
      this.enqueue({ t: "host", hostId: result.effect.hostId });
    }
    this.enqueue({ t: "snapshot", snapshot: this.snapshot() });
  }

  /** Mirrors the DO: every applied effect becomes its wire message + snapshot reconcile. */
  private flushEffect(effect: Effect | null): void {
    if (!effect) {
      return;
    }
    switch (effect.kind) {
      case "host-changed":
        this.enqueue({ t: "host", hostId: effect.hostId });
        break;
      case "cell-updated":
        this.enqueue({ t: "cell-updated", i: effect.i, v: effect.v, byPlayer: effect.byPlayer });
        this.emitSnapshot();
        break;
      case "note-changed":
        this.enqueue({ t: "note-changed", i: effect.i, values: effect.values, byPlayer: effect.byPlayer });
        break;
      case "started":
      case "completed":
        this.emitSnapshot();
        break;
      default:
        break;
    }
  }

  private emitSnapshot(): void {
    this.enqueue({ t: "snapshot", snapshot: this.snapshot() });
  }

  private snapshot(): ReturnType<typeof buildSnapshot> {
    return buildSnapshot(this.state!, [this.playerId], Date.now());
  }

  private enqueue(message: ServerMessage): void {
    if (this.closed) {
      return;
    }
    this.outbox.push(message);
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (this.closed) {
      return;
    }
    for (const message of this.outbox.splice(0)) {
      dispatchMessage(this.handlers, JSON.stringify(message));
    }
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
