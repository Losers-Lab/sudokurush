import { DurableObject } from "cloudflare:workers";
import { planGhostSweep } from "./ghost-sweep";
import type { Env } from "./env";
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_ROOM_FULL,
  DEFAULT_MAX_PLAYERS,
  PING_MESSAGE,
  PONG_MESSAGE,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/protocol";
import {
  applyHello,
  applyLeave,
  applyNote,
  applyStart,
  buildSnapshot,
  createLobby,
  judgePlacement,
  type LobbyState,
} from "../../shared/lobby-core";
import { BROKER_SINGLETON } from "./broker";
import { rejectUpgrade } from "./upgrade";

const MAX_NAME_LENGTH = 32;
const HELLO_TIMEOUT_MS = 30_000;
// Doubles as the broker heartbeat cadence; ROOM_TTL_MS in broker.ts must
// stay a comfortable multiple of this.
const ALARM_INTERVAL_MS = 10 * 60_000;
// Non-cursor messages are player-paced; the bucket only exists so a hostile
// client cannot convert one socket into unbounded billable invocations.
const MESSAGE_BURST_LIMIT = 25;
const MESSAGE_BURST_WINDOW_MS = 1_000;
// A seat whose socket vanished without a deliverable close frame stops
// counting against the roster cap after this much silence. Shorter than a
// race game needs: an 8-seat cooperative board feels broken when ghosts
// hold seats, and a swept seat rejoins into the full current state anyway.
const GHOST_GRACE_MS = 5 * 60_000;
/** Liveness stamps refresh at most this often, so extra alarms stay write-free. */
const GHOST_STAMP_INTERVAL_MS = ALARM_INTERVAL_MS;
// Selected-cell sharing is visual sugar; ~6-7 updates/s per seat reads live
// without turning every move into a billable relay request.
const CURSOR_MIN_INTERVAL_MS = 150;

/** Hard ceiling so a misconfigured MAX_PLAYERS var cannot admit unbounded rooms. */
export function resolveMaxPlayers(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_MAX_PLAYERS;
  }
  return Math.min(30, Math.max(1, parsed));
}

/**
 * Plain-object form of LobbyState for storage: Durable Object storage
 * serializes fine, but explicit records keep the blob diffable in dashboards
 * and make the server-only `solution` field impossible to ship by accident.
 */
type StoredLobby = Omit<LobbyState, "owners" | "notes"> & {
  owners: Record<string, string>;
  notes: Record<string, number[]>;
};

function serialize(state: LobbyState): StoredLobby {
  return {
    ...state,
    owners: Object.fromEntries(state.owners),
    notes: Object.fromEntries(state.notes),
  };
}

function deserialize(stored: StoredLobby): LobbyState {
  return {
    ...stored,
    owners: new Map(Object.entries(stored.owners ?? {}).map(([key, value]) => [Number(key), value])),
    notes: new Map(
      Object.entries(stored.notes ?? {}).map(([key, value]) => [Number(key), [...value]]),
    ),
  };
}

type SocketAttachment = { playerId: string };

export class GameRoom extends DurableObject<Env> {
  private readonly roomId: string;
  private readonly maxPlayers: number;
  private state: LobbyState | null = null;
  private sockets = new Map<string, WebSocket>();
  private pending = new Map<WebSocket, number>();
  private lastCursorAt = new Map<string, number>();
  private msgBuckets = new Map<string, { windowStart: number; count: number }>();
  private ready: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.roomId = ctx.id.name ?? ctx.id.toString();
    this.maxPlayers = resolveMaxPlayers(env.MAX_PLAYERS);
    // Answered by the runtime while hibernating, so keepalives never wake us.
    // Built from the shared frames — a client-side rename would otherwise
    // silently turn every keepalive into a billable wake-up.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify(PING_MESSAGE), JSON.stringify(PONG_MESSAGE)),
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket required" }, { status: 426 });
    }
    await this.ensureReady();
    const playerId = new URL(request.url).searchParams.get("player") || crypto.randomUUID();
    const returning = this.state !== null && this.state.players.some((p) => p.id === playerId);
    // Capacity gates NEW seats only: returning players (refresh, reconnect)
    // always reclaim their spot — the reconnect path depends on it.
    if (!returning && this.state !== null && this.state.players.length >= this.maxPlayers) {
      return rejectUpgrade("lobby-full", CLOSE_ROOM_FULL);
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.serializeAttachment({ playerId } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [`player:${playerId}`, `room:${this.roomId}`]);
    this.pending.set(server, Date.now());
    // Enforce the hello deadline on its own schedule: waiting out the full
    // heartbeat cadence would let a hello-less socket linger ~10 minutes.
    await this.armSoonestAlarm(HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ensureReady();
    if (typeof raw !== "string") {
      this.sendTo(ws, { t: "rejected", reason: "binary unsupported" });
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendTo(ws, { t: "rejected", reason: "malformed json" });
      return;
    }
    if (typeof message?.t !== "string") {
      this.sendTo(ws, { t: "rejected", reason: "malformed message" });
      return;
    }

    const playerId = this.attachedPlayer(ws);
    if (playerId === null) {
      this.sendTo(ws, { t: "rejected", reason: "unidentified socket" });
      return;
    }
    if (message.t === "hello") {
      await this.join(ws, playerId, message.name, message.avatar);
      return;
    }
    if (!this.isMember(playerId)) {
      this.sendTo(ws, { t: "rejected", reason: "hello required" });
      return;
    }
    if (this.exceedsMessageBudget(playerId)) {
      return;
    }

    switch (message.t) {
      case "start":
        await this.start(playerId, message.difficulty);
        break;
      case "place":
        await this.place(playerId, message.i, message.v);
        break;
      case "add-note":
        await this.note(playerId, "add", message.i, message.v);
        break;
      case "remove-note":
        await this.note(playerId, "remove", message.i, message.v);
        break;
      case "cursor":
        this.relayCursor(ws, playerId, message.i);
        break;
      case "ping":
        // The auto-response pair answers compliant pings while hibernating;
        // a ping here means it arrived mid-wake, so answer inline.
        this.sendTo(ws, PONG_MESSAGE);
        break;
      default:
        this.sendTo(ws, { t: "rejected", reason: "unknown message" });
    }
  }

  /**
   * Sliding one-second bucket per seat. Legitimate play stays well under the
   * limit; this only caps hostile floods of billable invocations.
   */
  private exceedsMessageBudget(playerId: string): boolean {
    const now = Date.now();
    let bucket = this.msgBuckets.get(playerId);
    if (!bucket || now - bucket.windowStart >= MESSAGE_BURST_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      this.msgBuckets.set(playerId, bucket);
    }
    bucket.count += 1;
    return bucket.count > MESSAGE_BURST_LIMIT;
  }

  /** Live selection sharing is pure relay traffic: no storage, sender excluded. */
  private relayCursor(sender: WebSocket, playerId: string, i: unknown): void {
    if (
      typeof i !== "number" ||
      !Number.isInteger(i) ||
      i < 0 ||
      i >= 81
    ) {
      return;
    }
    // A cursor with no audience is pure cost: solo sessions would otherwise
    // bill relay requests nobody can ever receive.
    if (this.ctx.getWebSockets().length <= 1) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastCursorAt.get(playerId) ?? 0) < CURSOR_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCursorAt.set(playerId, now);
    this.broadcast({ t: "cursor", byPlayer: playerId, i }, sender);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureReady();
    const playerId = this.attachedPlayer(ws);
    this.pending.delete(ws);
    if (!playerId || this.sockets.get(playerId) !== ws) {
      // A reconnect already took the player's seat; this is just the stale twin.
      return;
    }
    this.sockets.delete(playerId);
    this.lastCursorAt.delete(playerId);
    this.msgBuckets.delete(playerId);
    if (!this.state) {
      return;
    }
    await this.removeSeat(playerId);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // Alarms wake a hibernated DO with no in-memory state; every predicate
    // below reads persisted state, so hydrate before deciding anything.
    await this.ensureReady();
    const now = Date.now();
    for (const [ws, joinedAt] of this.pending) {
      if (now - joinedAt > HELLO_TIMEOUT_MS) {
        this.pending.delete(ws);
        ws.close(CLOSE_HELLO_TIMEOUT, "hello-timeout");
      }
    }
    if (this.ctx.getWebSockets().length === 0 || this.isEmpty()) {
      await this.teardown();
      return;
    }
    await this.reconcileGhosts();
    if (!this.state) {
      // The last seat turned out to be a ghost; teardown already cleared
      // storage and the alarm, so resume nothing.
      return;
    }
    await this.heartbeatBroker();
    await this.scheduleAlarm();
  }

  private async join(
    ws: WebSocket,
    playerId: string,
    rawName: unknown,
    rawAvatar: unknown,
  ): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const wasMember = this.isMember(playerId);
    this.pending.delete(ws);
    // Register before any reply so the welcome finds its socket.
    this.sockets.set(playerId, ws);
    const before = applyHello(state, playerId, rawName, rawAvatar, Date.now());
    if (!wasMember) {
      console.log(
        JSON.stringify({
          event: "player_join",
          roomId: this.roomId,
          playerId,
          name: state.players.find((p) => p.id === playerId)?.name,
        }),
      );
    }
    const hostChanged =
      before.effect?.kind === "host-changed" ? before.effect.hostId : null;
    await this.persist();
    this.sendTo(ws, { t: "welcome", you: playerId, snapshot: this.snapshot() });
    if (hostChanged) {
      this.broadcast({ t: "host", hostId: hostChanged });
    }
    // The joiner already holds the freshest state via welcome; re-sending
    // the identical snapshot to that socket doubles its parse for nothing.
    this.broadcast({ t: "snapshot", snapshot: this.snapshot() }, ws);
  }

  private async start(playerId: string, difficulty: unknown): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const result = applyStart(state, playerId, difficulty, newSeed(), Date.now());
    if (!result.ok) {
      this.deny(playerId, result.reason);
      return;
    }
    console.log(
      JSON.stringify({
        event: "game_started",
        roomId: this.roomId,
        difficulty: state.difficulty,
        givens: state.givens.filter((cell) => cell !== 0).length,
      }),
    );
    await this.persist();
    this.broadcast({ t: "snapshot", snapshot: this.snapshot() });
  }

  /**
   * Fan out one judged move: accepted placements paint every board via the
   * event, then the snapshot reconciles the derived panels (placements,
   * mistakes, status). Wrong digits stay private to their submitter.
   */
  private async place(playerId: string, i: unknown, v: unknown): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const judged = judgePlacement(state, playerId, i, v, Date.now());
    switch (judged.verdict) {
      case "rejected": {
        const ws = this.sockets.get(playerId);
        if (ws) {
          this.sendTo(ws, { t: "rejected", reason: judged.reason, ...(judged.i !== undefined ? { i: judged.i } : {}) });
        }
        return;
      }
      case "incorrect": {
        await this.persist();
        const ws = this.sockets.get(playerId);
        if (ws) {
          this.sendTo(ws, { t: "invalid", i: judged.i });
        }
        // Mistake counts show on every player panel, so the corrected total
        // fans out with a snapshot even though the digit itself stays private.
        this.broadcast({ t: "snapshot", snapshot: this.snapshot() });
        return;
      }
      case "accepted": {
        await this.persist();
        if (judged.solved) {
          console.log(
            JSON.stringify({
              event: "game_completed",
              roomId: this.roomId,
              seconds: state.startedAt !== null ? Math.round((Date.now() - state.startedAt) / 1000) : null,
              placements: state.placements,
            }),
          );
        }
        this.broadcast({
          t: "cell-updated",
          i: judged.i,
          v: judged.v,
          byPlayer: judged.byPlayer,
        });
        this.broadcast({ t: "snapshot", snapshot: this.snapshot() });
        return;
      }
    }
  }

  private async note(
    playerId: string,
    mode: "add" | "remove",
    i: unknown,
    v: unknown,
  ): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const judged = applyNote(state, playerId, mode, i, v);
    if (judged.verdict === "rejected") {
      const ws = this.sockets.get(playerId);
      if (ws) {
        this.sendTo(ws, {
          t: "rejected",
          reason: judged.reason,
          ...(judged.i !== undefined ? { i: judged.i } : {}),
        });
      }
      return;
    }
    await this.persist();
    this.broadcast({
      t: "note-changed",
      i: judged.i,
      values: judged.values,
      byPlayer: judged.byPlayer,
    });
  }

  /**
   * Drops one seat and settles what depended on it — host handoff, teardown
   * on the last departure. Shared by the socket-close path and the alarm's
   * ghost sweep so both leave the room in exactly the same shape.
   */
  private async removeSeat(playerId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const departed = state.players.find((p) => p.id === playerId);
    const newHost = applyLeave(state, playerId);
    if (departed) {
      console.log(
        JSON.stringify({
          event: "player_leave",
          roomId: this.roomId,
          playerId,
          secondsPlayed: Math.round((Date.now() - departed.joinedAt) / 1000),
        }),
      );
    }
    if (state.players.length === 0) {
      await this.teardown();
      return;
    }
    if (newHost) {
      await this.persist();
      this.broadcast({ t: "host", hostId: newHost });
    }
    await this.persist();
    this.broadcast({ t: "snapshot", snapshot: this.snapshot() });
  }

  /**
   * Seats whose socket disappeared without a close frame never trigger
   * webSocketClose, so only this periodic sweep can reclaim them — otherwise
   * ghosts hold the roster cap forever. Live sockets and legacy seats (no
   * stamp yet) just get stamped.
   */
  private async reconcileGhosts(): Promise<void> {
    const state = this.state;
    if (!state || state.players.length === 0) {
      return;
    }
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attached = ws.deserializeAttachment() as SocketAttachment | null;
      if (attached && typeof attached.playerId === "string") {
        live.add(attached.playerId);
      }
    }
    const now = Date.now();
    // Restamping is throttled so the extra alarms this DO wakes for (hello
    // deadlines) don't buy a blob write each.
    const plan = planGhostSweep(state.players, live, now, GHOST_GRACE_MS, GHOST_STAMP_INTERVAL_MS);
    let touched = plan.stamps.size > 0;
    for (const [pid, at] of plan.stamps) {
      const player = state.players.find((p) => p.id === pid);
      if (player) {
        player.lastSeenAt = at;
      }
    }
    if (plan.ghosts.length > 0) {
      for (const playerId of plan.ghosts) {
        if (!this.state) {
          return;
        }
        await this.removeSeat(playerId);
      }
      return;
    }
    if (touched) {
      await this.persist();
    }
  }

  private deny(playerId: string, reason: string): void {
    const ws = this.sockets.get(playerId);
    if (ws) {
      this.sendTo(ws, { t: "rejected", reason });
    }
  }

  private isMember(playerId: string): boolean {
    return this.state?.players.some((p) => p.id === playerId) ?? false;
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      const stored = await this.ctx.storage.get<StoredLobby>("lobby");
      this.state =
        stored === null
          ? createLobby("medium")
          : deserialize(stored as unknown as StoredLobby);
      for (const ws of this.ctx.getWebSockets()) {
        const attached = ws.deserializeAttachment() as SocketAttachment | null;
        if (attached && typeof attached.playerId === "string") {
          this.sockets.set(attached.playerId, ws);
        }
      }
    })();
    return this.ready;
  }

  private isEmpty(): boolean {
    return this.state === null || this.state.players.length === 0;
  }

  /** The ONLY path from game state to the network: solution-free by construction. */
  private snapshot() {
    return buildSnapshot(this.state!, this.onlineIds(), Date.now());
  }

  private onlineIds(): string[] {
    return [...this.sockets.keys()];
  }

  private attachedPlayer(ws: WebSocket): string | null {
    if (ws.deserializeAttachment) {
      const attached = ws.deserializeAttachment() as SocketAttachment | null;
      if (attached) {
        return attached.playerId;
      }
    }
    const tag = this.ctx.getTags(ws).find((tag) => tag.startsWith("player:"));
    return tag ? tag.slice("player:".length) : null;
  }

  private sendTo(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const encoded = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(encoded);
      }
    }
  }

  private async scheduleAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * Arms an alarm `within` ms from now unless one already fires sooner.
   * Never clobbers a nearer deadline.
   */
  private async armSoonestAlarm(within: number): Promise<void> {
    const deadline = Date.now() + within;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > deadline) {
      await this.ctx.storage.setAlarm(deadline);
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("lobby", serialize(this.state!));
  }

  private async teardown(): Promise<void> {
    for (const ws of this.pending.keys()) {
      ws.close(CLOSE_HELLO_TIMEOUT, "lobby-closed");
    }
    this.pending.clear();
    this.lastCursorAt.clear();
    this.msgBuckets.clear();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.state = null;
    this.ready = null;
    await this.releaseWithBroker();
  }

  private async heartbeatBroker(): Promise<void> {
    const state = this.state;
    // Early alarms (hello deadlines) must not multiply broker traffic: the
    // TTL math assumes roughly one beat per interval.
    if (state?.brokerBeatAt !== undefined && Date.now() - state.brokerBeatAt < ALARM_INTERVAL_MS * 0.75) {
      return;
    }
    await this.brokerCall("heartbeat").catch(() => undefined);
    // Deliberately unpersisted: losing the stamp to an eviction just buys
    // one redundant beat, and saving it would cost a blob write every beat.
    if (state) {
      state.brokerBeatAt = Date.now();
    }
  }

  private async releaseWithBroker(): Promise<void> {
    await this.brokerCall("release").catch(() => undefined);
  }

  private brokerCall(action: "heartbeat" | "release"): Promise<Response> {
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName(BROKER_SINGLETON));
    return broker.fetch(`https://broker/${action}`, {
      method: "POST",
      body: JSON.stringify({ roomId: this.roomId }),
    });
  }
}

/** Relay-owned randomness for puzzle deals; kept out of the pure core. */
function newSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
