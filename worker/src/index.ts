import { BROKER_SINGLETON } from "./broker.ts";
import { CLOSE_CAPACITY, CLOSE_UNVERIFIED } from "../../shared/protocol.ts";
import { admitRoomId } from "./roomIds.ts";
import { exchangeCode } from "./token.ts";
import { rejectUpgrade } from "./upgrade.ts";
import type { Env } from "./env.ts";

export { GameRoom } from "./room.ts";
export { RoomBroker } from "./broker.ts";

const ROOM_ROUTE = /^\/api\/room\/([^/]+)$/;
const LEGAL_ROUTES = new Map([
  ["/privacy", "/privacy.html"],
  ["/terms", "/terms.html"],
]);

type AdmitReply = { ok?: boolean; reason?: string };

type AdmitResult = { ok: true } | { ok: false; reason: string };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/token") {
      return exchangeCode(request, env);
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    const legal = LEGAL_ROUTES.get(url.pathname);
    if (legal) {
      return env.AppAssets.fetch(new Request(new URL(legal, request.url)));
    }

    const roomMatch = ROOM_ROUTE.exec(url.pathname);
    if (roomMatch) {
      let roomId: string;
      try {
        roomId = decodeURIComponent(roomMatch[1]);
      } catch {
        return rejectUpgrade("invalid-room-id", CLOSE_UNVERIFIED);
      }
      return enterRoom(roomId, request, env);
    }
    return env.AppAssets.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function enterRoom(roomId: string, request: Request, env: Env): Promise<Response> {
  const admissible = await admitRoomId(roomId, env);
  if (!admissible.ok) {
    return rejectUpgrade(admissible.reason, CLOSE_UNVERIFIED);
  }
  // Address by the canonical form so `open:abc234` and `open:ABC234` are one
  // lobby and one capacity slot, not parallel DOs.
  const admitted = await admit(admissible.roomId, env);
  if (!admitted.ok) {
    return rejectUpgrade(admitted.reason, CLOSE_CAPACITY);
  }
  return env.ROOM.get(env.ROOM.idFromName(admissible.roomId)).fetch(request);
}

async function admit(roomId: string, env: Env): Promise<AdmitResult> {
  const broker = env.BROKER.get(env.BROKER.idFromName(BROKER_SINGLETON));
  const reply: AdmitReply = await broker
    .fetch("https://broker/admit", {
      method: "POST",
      body: JSON.stringify({ roomId }),
    })
    .then((response) => response.json<AdmitReply>())
    // A broker outage must not take live games down; the gate is advisory.
    .catch(() => ({}) as AdmitReply);
  if (reply.ok) {
    return { ok: true };
  }
  return { ok: false, reason: reply.reason ?? "capacity" };
}
