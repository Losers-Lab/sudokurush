import { isValidRoomCode } from "../../shared/roomCodes.ts";
import type { Env } from "./env.ts";
import { verifyInstance } from "./instances.ts";

/**
 * Room ids are namespaced by origin so the Discord path and casual browser
 * path cannot reach each other: raw ids are platform instances (verified),
 * `open:` ids are human codes gated behind an explicit deploy-time flag.
 */
export type RoomReferral =
  | { kind: "discord-instance"; id: string }
  | { kind: "open-code"; code: string };

const OPEN_PREFIX = "open:";

export function parseRoomId(raw: string): RoomReferral | null {
  if (raw.startsWith(OPEN_PREFIX)) {
    const code = raw.slice(OPEN_PREFIX.length).toUpperCase();
    return isValidRoomCode(code) ? { kind: "open-code", code } : null;
  }
  if (!raw || raw.includes(":") || raw.length > 128) {
    return null;
  }
  return { kind: "discord-instance", id: raw };
}

export async function admitRoomId(
  raw: string,
  env: Env,
): Promise<{ ok: true; roomId: string } | { ok: false; reason: string }> {
  const referral = parseRoomId(raw);
  if (referral === null) {
    return { ok: false, reason: "invalid-room" };
  }
  if (referral.kind === "discord-instance") {
    return (await verifyInstance(referral.id, env))
      ? { ok: true, roomId: referral.id }
      : { ok: false, reason: "unknown-instance" };
  }
  const enabled = /^(1|true|yes)$/i.test(env.OPEN_ROOMS ?? "");
  // Canonicalize so every casing of a code lands in the same DO.
  const canonical = `${OPEN_PREFIX}${referral.code}`;
  return enabled
    ? { ok: true, roomId: canonical }
    : { ok: false, reason: "open-rooms-disabled" };
}
