import type { Env } from "./env";

const POSITIVE_CACHE_TTL_MS = 60_000;

/** Insert-time trigger to sweep expired positives instead of growing forever. */
const VERIFIED_SWEEP_SIZE = 256;

const verifiedUntil = new Map<string, number>();

/**
 * Confirms a room id names a real activity instance of this application.
 * Definitive negatives (404) fail closed; indeterminate outcomes (network
 * errors, rate limits, auth problems) fail open so an outage or config
 * mistake can never take live games down — the gate stops strangers hopping
 * into private rooms, it must not become a second availability dependency.
 */
export async function verifyInstance(roomId: string, env: Env): Promise<boolean> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token || !env.DISCORD_CLIENT_ID) {
    return true;
  }
  const cached = verifiedUntil.get(roomId);
  if (cached !== undefined && Date.now() < cached) {
    return true;
  }

  try {
    const response = await fetch(
      `https://discord.com/api/applications/${env.DISCORD_CLIENT_ID}/activity-instances/${encodeURIComponent(roomId)}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (response.ok) {
      // Entries only expire logically; without this sweep the map grows for
      // the isolate's whole life (room ids reach 128 chars each).
      if (verifiedUntil.size >= VERIFIED_SWEEP_SIZE) {
        const now = Date.now();
        for (const [id, until] of verifiedUntil) {
          if (until <= now) {
            verifiedUntil.delete(id);
          }
        }
      }
      verifiedUntil.set(roomId, Date.now() + POSITIVE_CACHE_TTL_MS);
      return true;
    }
    if (response.status === 404) {
      verifiedUntil.delete(roomId);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}
