import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { CloudflareRoomLimit, type RoomLimitSource } from "./capacity.ts";

/** Singleton name; every worker instance resolves to this one broker DO. */
export const BROKER_SINGLETON = "lobby-broker";

type AdmitResult = { ok: true } | { ok: false; reason: string };

type LobbyRecord = {
  createdAt: number;
  /** Refreshed by GameRoom alarms while occupied; the sweep's liveness signal. */
  lastSeen: number;
};

// Generous on purpose: a lobby whose alarm keeps firing while occupied is
// refreshed well inside this window, so only genuinely orphaned records
// (e.g. a lobby that died mid-deploy without releasing) get swept.
// Must stay a comfortable multiple of ALARM_INTERVAL_MS in room.ts — three
// beats of missed-heartbeat tolerance.
const LOBBY_TTL_MS = 30 * 60_000;

/** Beats closer than this to the last refresh skip their registry rewrite. */
const HEARTBEAT_COALESCE_MS = 5 * 60_000;

export class RoomBroker extends DurableObject<Env> {
  private readonly limits: RoomLimitSource;
  private loaded: Promise<Map<string, LobbyRecord>> | null = null;

  constructor(ctx: DurableObjectState, env: Env, limits?: RoomLimitSource) {
    super(ctx, env);
    this.limits = limits ?? new CloudflareRoomLimit(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json<{ roomId?: string }>() : {};
    const roomId = body.roomId ?? "";
    if (!roomId) {
      return Response.json({ error: "missing roomId" }, { status: 400 });
    }

    let result: unknown;
    if (url.pathname === "/admit") {
      result = await this.admit(roomId);
    } else if (url.pathname === "/release") {
      const lobbies = await this.registry();
      lobbies.delete(roomId);
      await this.persist(lobbies);
      result = { ok: true };
    } else if (url.pathname === "/heartbeat") {
      const lobbies = await this.registry();
      const record = lobbies.get(roomId);
      // Every occupied lobby beats on the same interval; coalescing beats
      // inside half that window collapses N lobbies' rewrites of the one
      // registry blob without ever letting a live record age toward the TTL.
      if (record && Date.now() - record.lastSeen > HEARTBEAT_COALESCE_MS) {
        record.lastSeen = Date.now();
        await this.persist(lobbies);
      }
      result = { ok: true };
    } else {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json(result);
  }

  private async admit(roomId: string): Promise<AdmitResult> {
    const lobbies = await this.registry();
    const existing = lobbies.get(roomId);
    if (existing) {
      // Capacity gates NEW lobbies only: joiners of a live lobby always pass.
      // Same coalescing as /heartbeat — a join burst must not rewrite the
      // registry once per joiner.
      if (Date.now() - existing.lastSeen > HEARTBEAT_COALESCE_MS) {
        existing.lastSeen = Date.now();
        await this.persist(lobbies);
      }
      return { ok: true };
    }

    this.sweep(lobbies);
    const limit = await this.limits.limit();
    if (limit !== null && lobbies.size >= limit) {
      return { ok: false, reason: "capacity" };
    }
    lobbies.set(roomId, { createdAt: Date.now(), lastSeen: Date.now() });
    await this.persist(lobbies);
    return { ok: true };
  }

  private sweep(lobbies: Map<string, LobbyRecord>): void {
    const now = Date.now();
    for (const [roomId, record] of lobbies) {
      if (now - record.lastSeen > LOBBY_TTL_MS) {
        lobbies.delete(roomId);
      }
    }
  }

  private registry(): Promise<Map<string, LobbyRecord>> {
    this.loaded ??= this.ctx.storage
      .get<Record<string, LobbyRecord>>("lobbies")
      .then((stored) => new Map(Object.entries(stored ?? {})));
    return this.loaded;
  }

  private async persist(lobbies: Map<string, LobbyRecord>): Promise<void> {
    await this.ctx.storage.put("lobbies", Object.fromEntries(lobbies));
  }
}
